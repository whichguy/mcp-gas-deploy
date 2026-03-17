/**
 * Promote Tool for mcp-gas-deploy
 *
 * Library-based file-push promotion model.
 * NOT the same as deploy action=promote (versioned-deployment re-pointing).
 * This tool copies files between separate -source library projects.
 * Consumers auto-update via developmentMode: true (HEAD).
 *
 * Architecture:
 *   Dev project → staging-source library → prod-source library
 *   Consumers: spreadsheet-bound scripts that shim → -source @ HEAD
 *
 * Operations:
 *   promote: push files from dev → staging-source (or staging-source → prod-source)
 *   status:  report current lib* environment state
 *   setup:   wire an existing consumer template to a -source library
 */

import {
  getDeploymentInfo, setDeploymentInfo, getRootConfig
} from '../config/deployConfig.js';
import { resolveProject } from '../utils/resolveProject.js';
import { prepareFilesForDeploy } from '../utils/filePrepare.js';
import { generatePromoteHints, generatePromoteErrorHints } from '../utils/promoteHints.js';
import { buildConsumerManifest, generateShimCode, validateUserSymbol } from '../utils/consumerShim.js';
import { ensureExecutionApi } from '../utils/manifestUtils.js';
import { syncSheets, type SheetSyncMode } from '../utils/sheetSync.js';
import { syncProperties } from '../utils/propertySync.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';
import type { GASFileOperations } from '../api/gasFileOperations.js';
import type { GASProjectOperations } from '../api/gasProjectOperations.js';
import type { SessionManager } from '../auth/sessionManager.js';
import type { DeploymentInfo } from '../config/deployConfig.js';

export interface PromoteToolParams {
  scriptId?: string;
  localDir?: string;
  operation?: 'promote' | 'status' | 'setup';
  to?: 'staging' | 'prod';
  description?: string;
  syncSheets?: SheetSyncMode;
  syncProperties?: boolean;
  reconcileProperties?: boolean;
  userSymbol?: string;
  templateScriptId?: string;
  stagingSourceScriptId?: string;
  dryRun?: boolean;
}

export interface PromoteToolResult {
  success: boolean;
  operation: string;
  scriptId?: string;
  localDir?: string;
  to?: string;
  dryRun?: boolean;
  // Environment IDs created/used
  stagingSourceScriptId?: string;
  stagingConsumerScriptId?: string;
  stagingSpreadsheetId?: string;
  stagingPromotedAt?: string;
  prodSourceScriptId?: string;
  prodConsumerScriptId?: string;
  prodSpreadsheetId?: string;
  prodPromotedAt?: string;
  // Step results
  filesPushed?: number;
  consumerShimUpdated?: boolean;
  sheetSyncResult?: unknown;
  propertySyncResult?: unknown;
  // Status report
  status?: {
    dev: Record<string, unknown>;
    staging: Record<string, unknown>;
    prod: Record<string, unknown>;
  };
  error?: string;
  hints: Record<string, string>;
}

export const PROMOTE_TOOL_DEFINITION = {
  name: 'promote',
  description: '[PROMOTE] Library-based file-push promotion. NOT the same as deploy action=promote (versioned slots). This tool copies ALL files between separate -source library projects; consumers auto-update via HEAD. Operations: promote (push files), status (check environments), setup (wire template).',
  annotations: {
    title: 'Promote GAS Files to Environments',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      ...SchemaFragments.localDir,
      ...SchemaFragments.dryRun,
      operation: {
        type: 'string' as const,
        enum: ['promote', 'status', 'setup'] as const,
        description: 'Operation: promote (push files), status (check environments), setup (wire template). Defaults to "promote".',
        default: 'promote',
      },
      to: {
        type: 'string' as const,
        enum: ['staging', 'prod'] as const,
        description: 'Promote target environment (required for promote operation).',
      },
      syncSheets: {
        type: 'string' as const,
        enum: ['smart', 'replace_all', 'add_new_only', 'off'] as const,
        description: 'Sheet sync mode. replace_all: overwrite all matching sheets. smart: overwrite app-owned sheets (_prefix/_defaults/_template). add_new_only: only copy missing sheets. off: skip sheet sync. Default: replace_all.',
        default: 'replace_all',
      },
      syncProperties: {
        type: 'boolean' as const,
        description: 'Sync ConfigManager properties between environments. Default: true.',
        default: true,
      },
      reconcileProperties: {
        type: 'boolean' as const,
        description: 'Delete target-only properties not in source (reconcile mode). Default: false.',
        default: false,
      },
      userSymbol: {
        type: 'string' as const,
        description: 'Library namespace for consumer shim (e.g. "SheetsChat"). Falls back to gas-deploy.json libUserSymbol or derived from project title.',
      },
      templateScriptId: {
        type: 'string' as const,
        description: 'Container-bound script to wire as consumer (setup operation only).',
        pattern: '^[A-Za-z0-9_-]{20,}$',
      },
      stagingSourceScriptId: {
        type: 'string' as const,
        description: 'Override staging-source scriptId for prod promote (escape hatch).',
        pattern: '^[A-Za-z0-9_-]{20,}$',
      },
      description: {
        type: 'string' as const,
        description: 'Description for this promote (stored as libStagingPromotedAt/libProdPromotedAt).',
      },
    },
    required: [] as string[],
    additionalProperties: false,
    llmGuidance: {
      libraryPromote: GuidanceFragments.libraryPromote,
      distinguish: 'This tool is NOT the same as deploy action=promote. deploy promotes version numbers within one project; this tool copies files between separate -source library projects.',
      workflow: 'Workflow: push → promote to=staging → test → promote to=prod.',
      setupTool: GuidanceFragments.setupTool,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      operation: { type: 'string' },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success', 'operation'],
  },
};

export async function handlePromoteTool(
  params: PromoteToolParams,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
): Promise<PromoteToolResult> {
  let resolved: { scriptId: string; localDir: string };
  try {
    resolved = await resolveProject({ scriptId: params.scriptId, localDir: params.localDir });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      operation: params.operation ?? 'promote',
      error: message,
      hints: generatePromoteErrorHints('promote', message),
    };
  }

  const { scriptId, localDir } = resolved;
  const operation = params.operation ?? 'promote';

  try {
    switch (operation) {
      case 'promote':
        return handlePromote(scriptId, localDir, params, fileOps, projectOps, sessionManager);
      case 'status':
        return handleStatus(scriptId, localDir, params, sessionManager);
      case 'setup':
        return handleSetup(scriptId, localDir, params, fileOps, sessionManager);
      default:
        return {
          success: false,
          operation,
          scriptId,
          localDir,
          error: `Unknown operation: ${operation as string}`,
          hints: { fix: 'Use operation="promote", "status", or "setup".' },
        };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      operation,
      scriptId,
      localDir,
      error: message,
      hints: generatePromoteErrorHints(operation, message),
    };
  }
}

// --- promote operation ---

async function handlePromote(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
): Promise<PromoteToolResult> {
  if (!params.to) {
    return {
      success: false,
      operation: 'promote',
      scriptId,
      localDir,
      error: 'Missing required parameter: to (must be "staging" or "prod").',
      hints: {
        fix: 'Specify promote target: to="staging" or to="prod".',
        workflow: 'Workflow: promote to=staging → test → promote to=prod.',
      },
    };
  }

  const deployInfo = await getDeploymentInfo(localDir, scriptId);
  const syncSheetsMode = params.syncSheets ?? 'replace_all';
  const shouldSyncProperties = params.syncProperties !== false;
  const dryRun = params.dryRun ?? false;

  if (params.to === 'staging') {
    return promoteToStaging(scriptId, localDir, params, deployInfo, fileOps, projectOps, sessionManager, syncSheetsMode, shouldSyncProperties, dryRun);
  } else {
    return promoteToProd(scriptId, localDir, params, deployInfo, fileOps, projectOps, sessionManager, syncSheetsMode, shouldSyncProperties, dryRun);
  }
}

async function promoteToStaging(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  deployInfo: DeploymentInfo,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
  syncSheetsMode: SheetSyncMode,
  shouldSyncProperties: boolean,
  dryRun: boolean,
): Promise<PromoteToolResult> {
  const hints: Record<string, string> = {};
  let info = { ...deployInfo };

  // Auto-create environment if missing (idempotent — checks each ID before creating)
  const userSymbol = await resolveUserSymbol(scriptId, localDir, params, projectOps);

  // Create staging-source library if needed
  if (!info.libStagingSourceScriptId) {
    if (dryRun) {
      hints.dryRun = 'Would create staging-source library.';
    } else {
      const title = `${userSymbol}-staging-source`;
      const created = await projectOps.createProject(title);
      info.libStagingSourceScriptId = created.scriptId;
      await setDeploymentInfo(localDir, scriptId, { libStagingSourceScriptId: created.scriptId });
    }
  }

  // Create staging spreadsheet if needed
  if (!info.libStagingSpreadsheetId) {
    if (dryRun) {
      hints.dryRun = (hints.dryRun ?? '') + ' Would create staging consumer spreadsheet.';
    } else {
      const spreadsheetId = await projectOps.createSpreadsheet(`${userSymbol} Staging`);
      info.libStagingSpreadsheetId = spreadsheetId;
      await setDeploymentInfo(localDir, scriptId, { libStagingSpreadsheetId: spreadsheetId });
    }
  }

  // Create staging consumer project (container-bound) if needed
  if (!info.libStagingConsumerScriptId && !dryRun) {
    const consumer = await projectOps.createProject(
      `${userSymbol}-staging-consumer`,
      info.libStagingSpreadsheetId
    );
    info.libStagingConsumerScriptId = consumer.scriptId;
    await setDeploymentInfo(localDir, scriptId, { libStagingConsumerScriptId: consumer.scriptId });
  }

  if (dryRun) {
    return {
      success: true,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'staging',
      dryRun: true,
      stagingSourceScriptId: info.libStagingSourceScriptId,
      stagingConsumerScriptId: info.libStagingConsumerScriptId,
      stagingSpreadsheetId: info.libStagingSpreadsheetId,
      hints: { dryRun: 'Dry run complete. No changes made.' },
    };
  }

  const stagingSourceScriptId = info.libStagingSourceScriptId!;

  // Read dev files and prepare for deploy
  const devFiles = await fileOps.getProjectFiles(scriptId);
  const prepared = prepareFilesForDeploy(devFiles);

  // Push to staging-source
  await fileOps.updateProjectFiles(stagingSourceScriptId, prepared);

  // Verify push
  const verifyFiles = await fileOps.getProjectFiles(stagingSourceScriptId);
  if (verifyFiles.length < prepared.length) {
    return {
      success: false,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'staging',
      error: `Push verification failed: pushed ${prepared.length} files but remote has ${verifyFiles.length}.`,
      hints: { fix: 'Re-run promote to retry the file push.' },
    };
  }

  // Validate/repair consumer shim
  let consumerShimUpdated = false;
  if (info.libStagingConsumerScriptId) {
    try {
      const shimResult = await validateAndRepairConsumerShim(
        info.libStagingConsumerScriptId,
        stagingSourceScriptId,
        userSymbol,
        fileOps
      );
      consumerShimUpdated = shimResult.updated;
    } catch (e) {
      hints.consumerShim = `Consumer shim validation failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Sheet sync
  let sheetSyncResult: unknown;
  const devSpreadsheetId = await projectOps.getProjectParentId(scriptId);
  if (devSpreadsheetId && info.libStagingSpreadsheetId) {
    try {
      sheetSyncResult = await syncSheets(
        devSpreadsheetId,
        info.libStagingSpreadsheetId,
        syncSheetsMode,
        scriptId,
        sessionManager,
        { headUrl: info.headUrl }
      );
    } catch (e) {
      hints.sheetSync = `Sheet sync failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Property sync (non-fatal)
  let propertySyncResult: unknown;
  if (shouldSyncProperties) {
    try {
      propertySyncResult = await syncProperties(
        scriptId,
        stagingSourceScriptId,
        sessionManager,
        {
          reconcile: params.reconcileProperties,
          consumerScriptId: info.libStagingConsumerScriptId,
          sourceHeadUrl: info.headUrl,
        }
      );
    } catch (e) {
      hints.propertySync = `Property sync failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Store timestamp
  const promotedAt = new Date().toISOString();
  const updates: Partial<DeploymentInfo> = {
    libStagingPromotedAt: promotedAt,
    libUserSymbol: userSymbol,
  };
  await setDeploymentInfo(localDir, scriptId, updates);

  return {
    success: true,
    operation: 'promote',
    scriptId,
    localDir,
    to: 'staging',
    stagingSourceScriptId,
    stagingConsumerScriptId: info.libStagingConsumerScriptId,
    stagingSpreadsheetId: info.libStagingSpreadsheetId,
    stagingPromotedAt: promotedAt,
    filesPushed: prepared.length,
    consumerShimUpdated,
    sheetSyncResult,
    propertySyncResult,
    hints: {
      ...hints,
      ...generatePromoteHints('promote', 'staging'),
    },
  };
}

async function promoteToProd(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  deployInfo: DeploymentInfo,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
  syncSheetsMode: SheetSyncMode,
  shouldSyncProperties: boolean,
  dryRun: boolean,
): Promise<PromoteToolResult> {
  const hints: Record<string, string> = {};
  let info = { ...deployInfo };

  // Resolve staging-source (escape hatch: params override)
  const stagingSourceScriptId = params.stagingSourceScriptId ?? info.libStagingSourceScriptId;
  if (!stagingSourceScriptId && !dryRun) {
    return {
      success: false,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'prod',
      error: 'No staging-source library found. Run promote({to: "staging"}) first.',
      hints: { fix: 'Run promote({to: "staging"}) before promoting to prod.' },
    };
  }

  const userSymbol = await resolveUserSymbol(scriptId, localDir, params, projectOps);

  // Create prod-source library if needed
  if (!info.libProdSourceScriptId) {
    if (dryRun) {
      hints.dryRun = 'Would create prod-source library.';
    } else {
      const created = await projectOps.createProject(`${userSymbol}-prod-source`);
      info.libProdSourceScriptId = created.scriptId;
      await setDeploymentInfo(localDir, scriptId, { libProdSourceScriptId: created.scriptId });
    }
  }

  // Create prod spreadsheet if needed
  if (!info.libProdSpreadsheetId) {
    if (dryRun) {
      hints.dryRun = (hints.dryRun ?? '') + ' Would create prod consumer spreadsheet.';
    } else {
      const spreadsheetId = await projectOps.createSpreadsheet(`${userSymbol} Production`);
      info.libProdSpreadsheetId = spreadsheetId;
      await setDeploymentInfo(localDir, scriptId, { libProdSpreadsheetId: spreadsheetId });
    }
  }

  // Create prod consumer project if needed
  if (!info.libProdConsumerScriptId && !dryRun) {
    const consumer = await projectOps.createProject(
      `${userSymbol}-prod-consumer`,
      info.libProdSpreadsheetId
    );
    info.libProdConsumerScriptId = consumer.scriptId;
    await setDeploymentInfo(localDir, scriptId, { libProdConsumerScriptId: consumer.scriptId });
  }

  if (dryRun) {
    return {
      success: true,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'prod',
      dryRun: true,
      prodSourceScriptId: info.libProdSourceScriptId,
      prodConsumerScriptId: info.libProdConsumerScriptId,
      prodSpreadsheetId: info.libProdSpreadsheetId,
      hints: { dryRun: 'Dry run complete. No changes made.' },
    };
  }

  const prodSourceScriptId = info.libProdSourceScriptId!;

  // Read from staging-source (not dev) for prod promote
  const stagingFiles = await fileOps.getProjectFiles(stagingSourceScriptId!);
  const prepared = prepareFilesForDeploy(stagingFiles);

  // Push to prod-source
  await fileOps.updateProjectFiles(prodSourceScriptId, prepared);

  // Verify push
  const verifyFiles = await fileOps.getProjectFiles(prodSourceScriptId);
  if (verifyFiles.length < prepared.length) {
    return {
      success: false,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'prod',
      error: `Push verification failed: pushed ${prepared.length} files but remote has ${verifyFiles.length}.`,
      hints: { fix: 'Re-run promote to retry the file push.' },
    };
  }

  // Validate/repair consumer shim
  let consumerShimUpdated = false;
  if (info.libProdConsumerScriptId) {
    try {
      const shimResult = await validateAndRepairConsumerShim(
        info.libProdConsumerScriptId,
        prodSourceScriptId,
        userSymbol,
        fileOps
      );
      consumerShimUpdated = shimResult.updated;
    } catch (e) {
      hints.consumerShim = `Consumer shim validation failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Sheet sync (from staging spreadsheet, not dev)
  let sheetSyncResult: unknown;
  if (info.libStagingSpreadsheetId && info.libProdSpreadsheetId) {
    try {
      sheetSyncResult = await syncSheets(
        info.libStagingSpreadsheetId,
        info.libProdSpreadsheetId,
        syncSheetsMode,
        scriptId,
        sessionManager,
        { headUrl: info.headUrl }
      );
    } catch (e) {
      hints.sheetSync = `Sheet sync failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Property sync (non-fatal)
  let propertySyncResult: unknown;
  if (shouldSyncProperties && stagingSourceScriptId) {
    try {
      propertySyncResult = await syncProperties(
        stagingSourceScriptId,
        prodSourceScriptId,
        sessionManager,
        {
          reconcile: params.reconcileProperties,
          consumerScriptId: info.libProdConsumerScriptId,
        }
      );
    } catch (e) {
      hints.propertySync = `Property sync failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Store timestamp
  const promotedAt = new Date().toISOString();
  await setDeploymentInfo(localDir, scriptId, {
    libProdPromotedAt: promotedAt,
    libUserSymbol: userSymbol,
  });

  return {
    success: true,
    operation: 'promote',
    scriptId,
    localDir,
    to: 'prod',
    stagingSourceScriptId: stagingSourceScriptId!,
    prodSourceScriptId,
    prodConsumerScriptId: info.libProdConsumerScriptId,
    prodSpreadsheetId: info.libProdSpreadsheetId,
    prodPromotedAt: promotedAt,
    filesPushed: prepared.length,
    consumerShimUpdated,
    sheetSyncResult,
    propertySyncResult,
    hints: {
      ...hints,
      ...generatePromoteHints('promote', 'prod'),
    },
  };
}

// --- status operation ---

async function handleStatus(
  scriptId: string,
  localDir: string,
  _params: PromoteToolParams,
  sessionManager: SessionManager,
): Promise<PromoteToolResult> {
  const info = await getDeploymentInfo(localDir, scriptId);

  // Build structured status
  const dev: Record<string, unknown> = {
    scriptId,
    headUrl: info.headUrl,
    gcpSwitched: info.gcpSwitched ?? false,
  };

  const staging: Record<string, unknown> = {
    sourceScriptId: info.libStagingSourceScriptId,
    consumerScriptId: info.libStagingConsumerScriptId,
    spreadsheetId: info.libStagingSpreadsheetId,
    promotedAt: info.libStagingPromotedAt,
  };

  const prod: Record<string, unknown> = {
    sourceScriptId: info.libProdSourceScriptId,
    consumerScriptId: info.libProdConsumerScriptId,
    spreadsheetId: info.libProdSpreadsheetId,
    promotedAt: info.libProdPromotedAt,
  };

  const hints = generatePromoteHints('status');

  if (!info.libStagingSourceScriptId) {
    hints.staging = 'No staging environment yet. Run promote({to: "staging"}) to create.';
  }
  if (!info.libProdSourceScriptId && info.libStagingSourceScriptId) {
    hints.prod = 'No prod environment yet. Run promote({to: "prod"}) after validating staging.';
  }

  if (info.libConfigManagerSyncFailed) {
    hints.configManagerSync = 'ConfigManager sync failed on last promote. Re-run promote to retry.';
  }

  return {
    success: true,
    operation: 'status',
    scriptId,
    localDir,
    status: { dev, staging, prod },
    hints,
  };
}

// --- setup operation (wire template) ---

async function handleSetup(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  fileOps: GASFileOperations,
  _sessionManager: SessionManager,
): Promise<PromoteToolResult> {
  const templateScriptId = params.templateScriptId;
  if (!templateScriptId) {
    return {
      success: false,
      operation: 'setup',
      scriptId,
      localDir,
      error: 'templateScriptId is required for promote operation="setup".',
      hints: { fix: 'Provide templateScriptId: the container-bound script to wire as a consumer.' },
    };
  }

  const deployInfo = await getDeploymentInfo(localDir, scriptId);
  const userSymbol = await resolveUserSymbol(scriptId, localDir, params, null);

  // Need a source scriptId to wire against
  const sourceId = deployInfo.libStagingSourceScriptId;
  if (!sourceId) {
    return {
      success: false,
      operation: 'setup',
      scriptId,
      localDir,
      error: 'No staging-source library found. Run promote({to: "staging"}) first to create the source library.',
      hints: { fix: 'Run promote({to: "staging"}) first, then wire templates.' },
    };
  }

  // Read template files
  const templateFiles = await fileOps.getProjectFiles(templateScriptId);

  // Build consumer manifest and shim
  const shimCode = generateShimCode(userSymbol);
  const consumerManifest = buildConsumerManifest(sourceId, userSymbol);

  const updatedFiles = templateFiles.map(f => {
    if (f.name === 'appsscript') {
      return { ...f, source: JSON.stringify(consumerManifest, null, 2) };
    }
    return f;
  });

  // Add/replace shim file
  const shimFile = { name: 'consumer_shim', type: 'SERVER_JS' as const, source: shimCode };
  const hasShim = updatedFiles.some(f => f.name === 'consumer_shim');
  const finalFiles = hasShim
    ? updatedFiles.map(f => f.name === 'consumer_shim' ? shimFile : f)
    : [...updatedFiles, shimFile];

  await fileOps.updateProjectFiles(templateScriptId, finalFiles);

  // Store template ID
  await setDeploymentInfo(localDir, scriptId, { libTemplateScriptId: templateScriptId });

  return {
    success: true,
    operation: 'setup',
    scriptId,
    localDir,
    hints: generatePromoteHints('setup'),
  };
}

// --- helpers ---

/**
 * Validate/repair the consumer shim to ensure it references the correct source library.
 */
async function validateAndRepairConsumerShim(
  consumerScriptId: string,
  sourceScriptId: string,
  userSymbol: string,
  fileOps: GASFileOperations,
): Promise<{ valid: boolean; updated: boolean; issue?: string }> {
  const files = await fileOps.getProjectFiles(consumerScriptId);
  const manifestFile = files.find(f => f.name === 'appsscript');

  if (!manifestFile?.source) {
    // No manifest — write fresh
    const consumerManifest = buildConsumerManifest(sourceScriptId, userSymbol);
    const shimCode = generateShimCode(userSymbol);
    const newFiles = [
      { name: 'appsscript', type: 'JSON' as const, source: JSON.stringify(consumerManifest, null, 2) },
      { name: 'consumer_shim', type: 'SERVER_JS' as const, source: shimCode },
    ];
    await fileOps.updateProjectFiles(consumerScriptId, newFiles);
    return { valid: false, updated: true, issue: 'Missing manifest — wrote fresh shim' };
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestFile.source) as Record<string, unknown>;
  } catch {
    return { valid: false, updated: false, issue: 'Could not parse manifest JSON' };
  }

  // Check library reference
  const deps = manifest.dependencies as { libraries?: Array<Record<string, unknown>> } | undefined;
  const libRef = deps?.libraries?.[0];
  const needsUpdate = !libRef ||
    libRef.libraryId !== sourceScriptId ||
    libRef.developmentMode !== true;

  if (needsUpdate) {
    const consumerManifest = buildConsumerManifest(sourceScriptId, userSymbol);
    const shimCode = generateShimCode(userSymbol);
    const updatedFiles = files.map(f => {
      if (f.name === 'appsscript') return { ...f, source: JSON.stringify(consumerManifest, null, 2) };
      if (f.name === 'consumer_shim') return { ...f, source: shimCode };
      return f;
    });
    const hasShim = files.some(f => f.name === 'consumer_shim');
    const finalFiles = hasShim ? updatedFiles : [
      ...updatedFiles,
      { name: 'consumer_shim', type: 'SERVER_JS' as const, source: shimCode },
    ];
    await fileOps.updateProjectFiles(consumerScriptId, finalFiles);
    return { valid: false, updated: true, issue: 'Stale library reference — updated to current source' };
  }

  return { valid: true, updated: false };
}

/**
 * Resolve userSymbol from: params → gas-deploy.json → derive from project title.
 */
async function resolveUserSymbol(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  projectOps: GASProjectOperations | null,
): Promise<string> {
  if (params.userSymbol) {
    validateUserSymbol(params.userSymbol);
    return params.userSymbol;
  }

  try {
    const info = await getDeploymentInfo(localDir, scriptId);
    if (info.libUserSymbol) return info.libUserSymbol;
  } catch {
    // Ignore
  }

  // Derive from project title if projectOps available
  if (projectOps) {
    try {
      const title = await projectOps.getProjectTitle(scriptId);
      if (title) {
        // Convert to valid identifier: take first word, capitalize, strip non-alnum
        const symbol = title.split(/\s+/)[0].replace(/[^a-zA-Z0-9_]/g, '') || 'App';
        validateUserSymbol(symbol);
        return symbol;
      }
    } catch {
      // Fall through
    }
  }

  return 'App';
}
