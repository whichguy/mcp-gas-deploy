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
  getDeploymentInfo, setDeploymentInfo,
} from '../config/deployConfig.js';
import { resolveProject } from '../utils/resolveProject.js';
import { prepareFilesForDeploy } from '../utils/filePrepare.js';
import { generatePromoteHints, generatePromoteErrorHints } from '../utils/promoteHints.js';
import { buildConsumerManifest, generateShimCode, validateUserSymbol } from '../utils/consumerShim.js';
import { syncSheets, type SheetSyncMode } from '../utils/sheetSync.js';
import { syncProperties } from '../utils/propertySync.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';
import { getConfigValue, setConfigValue } from '../utils/execHelper.js';
import type { GASFileOperations } from '../api/gasFileOperations.js';
import type { GASProjectOperations } from '../api/gasProjectOperations.js';
import type { SessionManager } from '../auth/sessionManager.js';
import type { DeploymentInfo } from '../config/deployConfig.js';

// Key names must match mcp_gas exactly for cross-tool consistency.
const CONFIG_KEYS = {
  staging: {
    sourceScriptId: 'STAGING_SOURCE_SCRIPT_ID',
    scriptId:       'STAGING_SCRIPT_ID',
    spreadsheetId:  'STAGING_SPREADSHEET_URL', // stores ID, not URL — matches mcp_gas
    promotedAt:     'STAGING_PROMOTED_AT',
  },
  prod: {
    sourceScriptId: 'PROD_SOURCE_SCRIPT_ID',
    scriptId:       'PROD_SCRIPT_ID',
    spreadsheetId:  'PROD_SPREADSHEET_URL',
    promotedAt:     'PROD_PROMOTED_AT',
  },
  userSymbol:       'USER_SYMBOL',
  templateScriptId: 'TEMPLATE_SCRIPT_ID',
} as const;

// Per-scriptId mutex — prevents concurrent promote races on the same project.
// Co-located here (not a shared utility) because promote lock semantics may
// diverge from push lock semantics (rsync.ts withPushLock) over time.
const promoteLocks = new Map<string, Promise<void>>();

/** Serialize promote operations per scriptId to prevent concurrent file-push races. */
async function withPromoteLock<T>(scriptId: string, fn: () => Promise<T>): Promise<T> {
  while (promoteLocks.has(scriptId)) { await promoteLocks.get(scriptId); }
  let resolve: () => void = () => {};
  const lock = new Promise<void>(r => { resolve = r; });
  promoteLocks.set(scriptId, lock);
  try { return await fn(); }
  finally { promoteLocks.delete(scriptId); resolve(); }
}

/** Resolved environment IDs — ConfigManager is authoritative, gas-deploy.json is fallback cache. */
interface EnvConfig {
  staging: { sourceScriptId?: string; consumerScriptId?: string; spreadsheetId?: string };
  prod:    { sourceScriptId?: string; consumerScriptId?: string; spreadsheetId?: string };
  userSymbol?: string;
  templateScriptId?: string;
}

/**
 * Read all environment IDs from ConfigManager (primary) in parallel,
 * falling back to gas-deploy.json lib* fields when ConfigManager is unavailable.
 */
async function getEnvironmentConfig(
  scriptId: string,
  localDir: string,
  sessionManager: SessionManager,
  options?: { headUrl?: string },
): Promise<EnvConfig> {
  const localInfo = await getDeploymentInfo(localDir, scriptId);

  const [
    stagingSourceScriptId,
    stagingConsumerScriptId,
    stagingSpreadsheetId,
    prodSourceScriptId,
    prodConsumerScriptId,
    prodSpreadsheetId,
    userSymbol,
  ] = await Promise.all([
    getConfigValue(scriptId, CONFIG_KEYS.staging.sourceScriptId, sessionManager, options),
    getConfigValue(scriptId, CONFIG_KEYS.staging.scriptId, sessionManager, options),
    getConfigValue(scriptId, CONFIG_KEYS.staging.spreadsheetId, sessionManager, options),
    getConfigValue(scriptId, CONFIG_KEYS.prod.sourceScriptId, sessionManager, options),
    getConfigValue(scriptId, CONFIG_KEYS.prod.scriptId, sessionManager, options),
    getConfigValue(scriptId, CONFIG_KEYS.prod.spreadsheetId, sessionManager, options),
    getConfigValue(scriptId, CONFIG_KEYS.userSymbol, sessionManager, options),
  ]);

  return {
    staging: {
      sourceScriptId:  stagingSourceScriptId  ?? localInfo.libStagingSourceScriptId,
      consumerScriptId: stagingConsumerScriptId ?? localInfo.libStagingConsumerScriptId,
      spreadsheetId:   stagingSpreadsheetId   ?? localInfo.libStagingSpreadsheetId,
    },
    prod: {
      sourceScriptId:  prodSourceScriptId  ?? localInfo.libProdSourceScriptId,
      consumerScriptId: prodConsumerScriptId ?? localInfo.libProdConsumerScriptId,
      spreadsheetId:   prodSpreadsheetId   ?? localInfo.libProdSpreadsheetId,
    },
    userSymbol:       userSymbol ?? localInfo.libUserSymbol,
    templateScriptId: localInfo.libTemplateScriptId,
  };
}

/**
 * Write a single env ID to both ConfigManager (non-fatal) and gas-deploy.json (always).
 * Returns whether the ConfigManager write failed — callers may surface a hint.
 */
async function storeEnvId(
  scriptId: string,
  localDir: string,
  configKey: string,
  libField: keyof DeploymentInfo,
  value: string,
  sessionManager: SessionManager,
  options?: { headUrl?: string },
): Promise<{ configManagerFailed: boolean }> {
  let configManagerFailed = false;
  try {
    await setConfigValue(scriptId, configKey, value, sessionManager, options);
  } catch {
    configManagerFailed = true;
  }
  await setDeploymentInfo(localDir, scriptId, { [libField]: value } as Partial<DeploymentInfo>);
  return { configManagerFailed };
}

/**
 * Write a PROMOTED_AT timestamp to ConfigManager (non-fatal) and gas-deploy.json.
 * Explicitly awaited at call sites — gas-deploy.json write completes before returning.
 */
async function storePromoteTimestamp(
  scriptId: string,
  localDir: string,
  env: 'staging' | 'prod',
  timestamp: string,
  sessionManager: SessionManager,
  options?: { headUrl?: string },
): Promise<void> {
  const configKey = env === 'staging' ? CONFIG_KEYS.staging.promotedAt : CONFIG_KEYS.prod.promotedAt;
  const libField: keyof DeploymentInfo = env === 'staging' ? 'libStagingPromotedAt' : 'libProdPromotedAt';
  try {
    await setConfigValue(scriptId, configKey, timestamp, sessionManager, options);
  } catch {
    // Non-fatal — gas-deploy.json write below is the authoritative local record
  }
  await setDeploymentInfo(localDir, scriptId, { [libField]: timestamp } as Partial<DeploymentInfo>);
}

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
        return handleStatus(scriptId, localDir, params, fileOps, sessionManager);
      case 'setup':
        return handleSetup(scriptId, localDir, params, fileOps, projectOps, sessionManager);
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

  const syncSheetsMode = params.syncSheets ?? 'replace_all';
  const shouldSyncProperties = params.syncProperties !== false;
  const dryRun = params.dryRun ?? false;

  return withPromoteLock(scriptId, () =>
    params.to === 'staging'
      ? promoteToStaging(scriptId, localDir, params, fileOps, projectOps, sessionManager, syncSheetsMode, shouldSyncProperties, dryRun)
      : promoteToProd(scriptId, localDir, params, fileOps, projectOps, sessionManager, syncSheetsMode, shouldSyncProperties, dryRun)
  );
}

async function promoteToStaging(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
  syncSheetsMode: SheetSyncMode,
  shouldSyncProperties: boolean,
  dryRun: boolean,
): Promise<PromoteToolResult> {
  const hints: Record<string, string> = {};

  const localInfo = await getDeploymentInfo(localDir, scriptId);
  const envConfig = await getEnvironmentConfig(scriptId, localDir, sessionManager, { headUrl: localInfo.headUrl });

  const userSymbol = await resolveUserSymbol(scriptId, localDir, params, projectOps, sessionManager, { headUrl: localInfo.headUrl });

  let stagingSourceScriptId = envConfig.staging.sourceScriptId;
  let stagingSpreadsheetId = envConfig.staging.spreadsheetId;
  let stagingConsumerScriptId = envConfig.staging.consumerScriptId;

  // Create staging-source library if needed
  if (!stagingSourceScriptId) {
    if (dryRun) {
      hints.dryRun = 'Would create staging-source library.';
    } else {
      const title = `${userSymbol}-staging-source`;
      const created = await projectOps.createProject(title);
      stagingSourceScriptId = created.scriptId;
      await storeEnvId(scriptId, localDir, CONFIG_KEYS.staging.sourceScriptId, 'libStagingSourceScriptId', stagingSourceScriptId, sessionManager, { headUrl: localInfo.headUrl });
    }
  }

  // Create staging spreadsheet if needed
  if (!stagingSpreadsheetId) {
    if (dryRun) {
      hints.dryRun = (hints.dryRun ?? '') + ' Would create staging consumer spreadsheet.';
    } else {
      const spreadsheetId = await projectOps.createSpreadsheet(`${userSymbol} Staging`);
      stagingSpreadsheetId = spreadsheetId;
      await storeEnvId(scriptId, localDir, CONFIG_KEYS.staging.spreadsheetId, 'libStagingSpreadsheetId', stagingSpreadsheetId, sessionManager, { headUrl: localInfo.headUrl });
    }
  }

  // Create staging consumer project (container-bound) if needed
  if (!stagingConsumerScriptId && !dryRun) {
    const consumer = await projectOps.createProject(
      `${userSymbol}-staging-consumer`,
      stagingSpreadsheetId,
    );
    stagingConsumerScriptId = consumer.scriptId;
    await storeEnvId(scriptId, localDir, CONFIG_KEYS.staging.scriptId, 'libStagingConsumerScriptId', stagingConsumerScriptId, sessionManager, { headUrl: localInfo.headUrl });
  }

  if (dryRun) {
    return {
      success: true,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'staging',
      dryRun: true,
      stagingSourceScriptId,
      stagingConsumerScriptId,
      stagingSpreadsheetId,
      hints: { dryRun: 'Dry run complete. No changes made.' },
    };
  }

  // Read dev files and prepare for deploy
  const devFiles = await fileOps.getProjectFiles(scriptId);
  const prepared = prepareFilesForDeploy(devFiles);

  // Extract oauthScopes/timeZone from dev manifest for accurate shim repair
  const devManifest = devFiles.find(f => f.name === 'appsscript');
  let oauthScopes: string[] | undefined;
  let timeZone: string | undefined;
  try {
    if (devManifest?.source) {
      const m = JSON.parse(devManifest.source) as Record<string, unknown>;
      oauthScopes = m.oauthScopes as string[] | undefined;
      timeZone = m.timeZone as string | undefined;
    }
  } catch { /* best-effort */ }

  // Push to staging-source
  await fileOps.updateProjectFiles(stagingSourceScriptId!, prepared);

  // Verify push
  const verifyFiles = await fileOps.getProjectFiles(stagingSourceScriptId!);
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
  if (stagingConsumerScriptId) {
    try {
      const shimResult = await validateAndRepairConsumerShim(
        stagingConsumerScriptId,
        stagingSourceScriptId!,
        userSymbol,
        fileOps,
        { oauthScopes, timeZone },
      );
      consumerShimUpdated = shimResult.updated;
    } catch (e) {
      hints.consumerShim = `Consumer shim validation failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Sheet sync
  let sheetSyncResult: unknown;
  const devSpreadsheetId = await projectOps.getProjectParentId(scriptId);
  if (devSpreadsheetId && stagingSpreadsheetId) {
    try {
      sheetSyncResult = await syncSheets(
        devSpreadsheetId,
        stagingSpreadsheetId,
        syncSheetsMode,
        scriptId,
        sessionManager,
        { headUrl: localInfo.headUrl },
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
        stagingSourceScriptId!,
        sessionManager,
        {
          reconcile: params.reconcileProperties,
          consumerScriptId: stagingConsumerScriptId,
          sourceHeadUrl: localInfo.headUrl,
        },
      );
    } catch (e) {
      hints.propertySync = `Property sync failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Store timestamp and userSymbol
  const promotedAt = new Date().toISOString();
  await storePromoteTimestamp(scriptId, localDir, 'staging', promotedAt, sessionManager, { headUrl: localInfo.headUrl });
  await setDeploymentInfo(localDir, scriptId, { libUserSymbol: userSymbol });

  return {
    success: true,
    operation: 'promote',
    scriptId,
    localDir,
    to: 'staging',
    stagingSourceScriptId: stagingSourceScriptId!,
    stagingConsumerScriptId,
    stagingSpreadsheetId,
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
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
  syncSheetsMode: SheetSyncMode,
  shouldSyncProperties: boolean,
  dryRun: boolean,
): Promise<PromoteToolResult> {
  const hints: Record<string, string> = {};

  const localInfo = await getDeploymentInfo(localDir, scriptId);
  const envConfig = await getEnvironmentConfig(scriptId, localDir, sessionManager, { headUrl: localInfo.headUrl });

  // Resolve staging-source (escape hatch: params override takes precedence)
  const stagingSourceScriptId = params.stagingSourceScriptId ?? envConfig.staging.sourceScriptId;
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

  const userSymbol = await resolveUserSymbol(scriptId, localDir, params, projectOps, sessionManager, { headUrl: localInfo.headUrl });

  let prodSourceScriptId = envConfig.prod.sourceScriptId;
  let prodSpreadsheetId = envConfig.prod.spreadsheetId;
  let prodConsumerScriptId = envConfig.prod.consumerScriptId;

  // Create prod-source library if needed
  if (!prodSourceScriptId) {
    if (dryRun) {
      hints.dryRun = 'Would create prod-source library.';
    } else {
      const created = await projectOps.createProject(`${userSymbol}-prod-source`);
      prodSourceScriptId = created.scriptId;
      await storeEnvId(scriptId, localDir, CONFIG_KEYS.prod.sourceScriptId, 'libProdSourceScriptId', prodSourceScriptId, sessionManager, { headUrl: localInfo.headUrl });
    }
  }

  // Create prod spreadsheet if needed
  if (!prodSpreadsheetId) {
    if (dryRun) {
      hints.dryRun = (hints.dryRun ?? '') + ' Would create prod consumer spreadsheet.';
    } else {
      const spreadsheetId = await projectOps.createSpreadsheet(`${userSymbol} Production`);
      prodSpreadsheetId = spreadsheetId;
      await storeEnvId(scriptId, localDir, CONFIG_KEYS.prod.spreadsheetId, 'libProdSpreadsheetId', prodSpreadsheetId, sessionManager, { headUrl: localInfo.headUrl });
    }
  }

  // Create prod consumer project if needed
  if (!prodConsumerScriptId && !dryRun) {
    const consumer = await projectOps.createProject(
      `${userSymbol}-prod-consumer`,
      prodSpreadsheetId,
    );
    prodConsumerScriptId = consumer.scriptId;
    await storeEnvId(scriptId, localDir, CONFIG_KEYS.prod.scriptId, 'libProdConsumerScriptId', prodConsumerScriptId, sessionManager, { headUrl: localInfo.headUrl });
  }

  if (dryRun) {
    return {
      success: true,
      operation: 'promote',
      scriptId,
      localDir,
      to: 'prod',
      dryRun: true,
      prodSourceScriptId,
      prodConsumerScriptId,
      prodSpreadsheetId,
      hints: { dryRun: 'Dry run complete. No changes made.' },
    };
  }

  // Read from staging-source (not dev) for prod promote
  const stagingFiles = await fileOps.getProjectFiles(stagingSourceScriptId!);
  const prepared = prepareFilesForDeploy(stagingFiles);

  // Extract oauthScopes/timeZone from staging manifest for accurate shim repair
  const stagingManifest = stagingFiles.find(f => f.name === 'appsscript');
  let oauthScopes: string[] | undefined;
  let timeZone: string | undefined;
  try {
    if (stagingManifest?.source) {
      const m = JSON.parse(stagingManifest.source) as Record<string, unknown>;
      oauthScopes = m.oauthScopes as string[] | undefined;
      timeZone = m.timeZone as string | undefined;
    }
  } catch { /* best-effort */ }

  // Push to prod-source
  await fileOps.updateProjectFiles(prodSourceScriptId!, prepared);

  // Verify push
  const verifyFiles = await fileOps.getProjectFiles(prodSourceScriptId!);
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
  if (prodConsumerScriptId) {
    try {
      const shimResult = await validateAndRepairConsumerShim(
        prodConsumerScriptId,
        prodSourceScriptId!,
        userSymbol,
        fileOps,
        { oauthScopes, timeZone },
      );
      consumerShimUpdated = shimResult.updated;
    } catch (e) {
      hints.consumerShim = `Consumer shim validation failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Sheet sync (from staging spreadsheet, not dev)
  let sheetSyncResult: unknown;
  if (envConfig.staging.spreadsheetId && prodSpreadsheetId) {
    try {
      sheetSyncResult = await syncSheets(
        envConfig.staging.spreadsheetId,
        prodSpreadsheetId,
        syncSheetsMode,
        scriptId,
        sessionManager,
        { headUrl: localInfo.headUrl },
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
        prodSourceScriptId!,
        sessionManager,
        {
          reconcile: params.reconcileProperties,
          consumerScriptId: prodConsumerScriptId,
        },
      );
    } catch (e) {
      hints.propertySync = `Property sync failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Store timestamp and userSymbol
  const promotedAt = new Date().toISOString();
  await storePromoteTimestamp(scriptId, localDir, 'prod', promotedAt, sessionManager, { headUrl: localInfo.headUrl });
  await setDeploymentInfo(localDir, scriptId, { libUserSymbol: userSymbol });

  return {
    success: true,
    operation: 'promote',
    scriptId,
    localDir,
    to: 'prod',
    stagingSourceScriptId: stagingSourceScriptId!,
    prodSourceScriptId: prodSourceScriptId!,
    prodConsumerScriptId,
    prodSpreadsheetId,
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
  fileOps: GASFileOperations,
  sessionManager: SessionManager,
): Promise<PromoteToolResult> {
  const localInfo = await getDeploymentInfo(localDir, scriptId);
  const envConfig = await getEnvironmentConfig(scriptId, localDir, sessionManager, { headUrl: localInfo.headUrl });

  // Read promoted-at timestamps from ConfigManager in parallel (fall back to gas-deploy.json)
  const [cmStagingPromotedAt, cmProdPromotedAt] = await Promise.all([
    getConfigValue(scriptId, CONFIG_KEYS.staging.promotedAt, sessionManager, { headUrl: localInfo.headUrl }),
    getConfigValue(scriptId, CONFIG_KEYS.prod.promotedAt, sessionManager, { headUrl: localInfo.headUrl }),
  ]);

  const scriptUrl = (id: string) => `https://script.google.com/d/${id}/edit`;

  // Live discrepancy check — verify consumer manifests reference the correct source library
  const discrepancies: string[] = [];

  if (envConfig.staging.sourceScriptId && envConfig.staging.consumerScriptId) {
    try {
      const consumerFiles = await fileOps.getProjectFiles(envConfig.staging.consumerScriptId);
      const manifestFile = consumerFiles.find(f => f.name === 'appsscript');
      if (manifestFile?.source) {
        const manifest = JSON.parse(manifestFile.source) as Record<string, unknown>;
        const deps = manifest.dependencies as { libraries?: Array<Record<string, unknown>> } | undefined;
        const libRef = deps?.libraries?.[0];
        if (!libRef || libRef.libraryId !== envConfig.staging.sourceScriptId || libRef.developmentMode !== true) {
          discrepancies.push('staging: consumer manifest references wrong source library');
        }
      }
    } catch {
      discrepancies.push('staging: failed to verify consumer manifest');
    }
  }

  if (envConfig.prod.sourceScriptId && envConfig.prod.consumerScriptId) {
    try {
      const consumerFiles = await fileOps.getProjectFiles(envConfig.prod.consumerScriptId);
      const manifestFile = consumerFiles.find(f => f.name === 'appsscript');
      if (manifestFile?.source) {
        const manifest = JSON.parse(manifestFile.source) as Record<string, unknown>;
        const deps = manifest.dependencies as { libraries?: Array<Record<string, unknown>> } | undefined;
        const libRef = deps?.libraries?.[0];
        if (!libRef || libRef.libraryId !== envConfig.prod.sourceScriptId || libRef.developmentMode !== true) {
          discrepancies.push('prod: consumer manifest references wrong source library');
        }
      }
    } catch {
      discrepancies.push('prod: failed to verify consumer manifest');
    }
  }

  const stagingDiscrepancies = discrepancies.filter(d => d.startsWith('staging:'));
  const prodDiscrepancies = discrepancies.filter(d => d.startsWith('prod:'));

  const dev: Record<string, unknown> = {
    scriptId,
    headUrl: localInfo.headUrl,
    gcpSwitched: localInfo.gcpSwitched ?? false,
  };

  const staging: Record<string, unknown> = {
    sourceScriptId:   envConfig.staging.sourceScriptId,
    sourceScriptUrl:  envConfig.staging.sourceScriptId  ? scriptUrl(envConfig.staging.sourceScriptId)  : undefined,
    consumerScriptId: envConfig.staging.consumerScriptId,
    consumerScriptUrl: envConfig.staging.consumerScriptId ? scriptUrl(envConfig.staging.consumerScriptId) : undefined,
    spreadsheetId:    envConfig.staging.spreadsheetId,
    spreadsheetUrl:   envConfig.staging.spreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${envConfig.staging.spreadsheetId}`
      : undefined,
    lastPromotedAt: cmStagingPromotedAt ?? localInfo.libStagingPromotedAt,
    ...(stagingDiscrepancies.length > 0 ? { discrepancies: stagingDiscrepancies } : {}),
  };

  const prod: Record<string, unknown> = {
    sourceScriptId:   envConfig.prod.sourceScriptId,
    sourceScriptUrl:  envConfig.prod.sourceScriptId  ? scriptUrl(envConfig.prod.sourceScriptId)  : undefined,
    consumerScriptId: envConfig.prod.consumerScriptId,
    consumerScriptUrl: envConfig.prod.consumerScriptId ? scriptUrl(envConfig.prod.consumerScriptId) : undefined,
    spreadsheetId:    envConfig.prod.spreadsheetId,
    spreadsheetUrl:   envConfig.prod.spreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${envConfig.prod.spreadsheetId}`
      : undefined,
    lastPromotedAt: cmProdPromotedAt ?? localInfo.libProdPromotedAt,
    ...(prodDiscrepancies.length > 0 ? { discrepancies: prodDiscrepancies } : {}),
  };

  const hints = generatePromoteHints('status');

  if (!envConfig.staging.sourceScriptId) {
    hints.staging = 'No staging environment yet. Run promote({to: "staging"}) to create.';
  }
  if (!envConfig.prod.sourceScriptId && envConfig.staging.sourceScriptId) {
    hints.prod = 'No prod environment yet. Run promote({to: "prod"}) after validating staging.';
  }
  if (discrepancies.length > 0) {
    hints.discrepancies = `Consumer manifest discrepancies detected: ${discrepancies.join('; ')}. Re-run promote to repair.`;
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
  projectOps: GASProjectOperations,
  sessionManager: SessionManager,
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

  if (templateScriptId === scriptId) {
    return {
      success: false,
      operation: 'setup',
      scriptId,
      localDir,
      error: 'templateScriptId must be a different project from the library scriptId.',
      hints: { fix: 'The library cannot depend on itself.' },
    };
  }

  const localInfo = await getDeploymentInfo(localDir, scriptId);
  const envConfig = await getEnvironmentConfig(scriptId, localDir, sessionManager, { headUrl: localInfo.headUrl });
  const userSymbol = await resolveUserSymbol(scriptId, localDir, params, projectOps, sessionManager, { headUrl: localInfo.headUrl });

  // Need a source scriptId to wire against (ConfigManager-first)
  const sourceId = envConfig.staging.sourceScriptId;
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
 * Passes oauthScopes and timeZone from the source manifest when available.
 */
async function validateAndRepairConsumerShim(
  consumerScriptId: string,
  sourceScriptId: string,
  userSymbol: string,
  fileOps: GASFileOperations,
  sourceManifest?: { oauthScopes?: string[]; timeZone?: string },
): Promise<{ valid: boolean; updated: boolean; issue?: string }> {
  const files = await fileOps.getProjectFiles(consumerScriptId);
  const manifestFile = files.find(f => f.name === 'appsscript');

  if (!manifestFile?.source) {
    // No manifest — write fresh
    const consumerManifest = buildConsumerManifest(sourceScriptId, userSymbol, sourceManifest?.oauthScopes, sourceManifest?.timeZone);
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
    const consumerManifest = buildConsumerManifest(sourceScriptId, userSymbol, sourceManifest?.oauthScopes, sourceManifest?.timeZone);
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
 * Resolve userSymbol from: params → ConfigManager USER_SYMBOL → gas-deploy.json → project title.
 */
async function resolveUserSymbol(
  scriptId: string,
  localDir: string,
  params: PromoteToolParams,
  projectOps: GASProjectOperations | null,
  sessionManager: SessionManager,
  options?: { headUrl?: string },
): Promise<string> {
  if (params.userSymbol) {
    validateUserSymbol(params.userSymbol);
    return params.userSymbol;
  }

  // Try ConfigManager first (authoritative cross-tool store)
  try {
    const cmSymbol = await getConfigValue(scriptId, CONFIG_KEYS.userSymbol, sessionManager, options);
    if (cmSymbol) {
      validateUserSymbol(cmSymbol);
      return cmSymbol;
    }
  } catch {
    // Fall through
  }

  // Fallback: gas-deploy.json
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
