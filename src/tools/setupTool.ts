/**
 * Setup Tool for mcp-gas-deploy
 *
 * Three-operation tool for GAS project execution readiness:
 *   - init:   one-time GCP project initialization — detect state, best-effort enable API, guide manual steps
 *   - script: per-script scripts.run readiness — GCP switch + manifest + verify
 *   - status: check setup state across all requirements
 *
 * Auto-detects operation when omitted.
 */

import { resolveProject } from '../utils/resolveProject.js';
import {
  getDeploymentInfo, setDeploymentInfo, getRootConfig, setRootConfig
} from '../config/deployConfig.js';
import { switchGcpProject, type ChromeDevtools } from '../utils/gcpSwitch.js';
import { executeViaScriptsRun } from '../utils/scriptsRunExecutor.js';
import { ensureExecutionApi, parseManifest } from '../utils/manifestUtils.js';
import { enableAppsScriptApi } from '../utils/serviceUsageApi.js';
import { loadOAuthConfig } from '../auth/oauthClient.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';
import type { GASFileOperations } from '../api/gasFileOperations.js';
import type { SessionManager } from '../auth/sessionManager.js';
import { getAuthHint } from '../utils/authHints.js';

const GCP_PROJECT_NUMBER_RE = /^\d{6,20}$/;

export type SetupOperation = 'init' | 'script' | 'status';

export interface SetupToolParams {
  operation?: SetupOperation;
  scriptId?: string;
  localDir?: string;
  gcpProjectNumber?: string;
}

export interface SetupRequirementStatus {
  present: boolean;
  value?: string;
  hint?: string;
}

export interface SetupToolResult {
  success: boolean;
  operation: SetupOperation;
  oauthConfig: SetupRequirementStatus;
  token: SetupRequirementStatus;
  gcpProjectNumber: SetupRequirementStatus;
  scriptId?: string;
  gcpSwitched?: SetupRequirementStatus;
  executionApi?: SetupRequirementStatus;
  scriptsRunVerified?: boolean;
  apiEnabled?: boolean | 'warning';
  apiEnabledHint?: string;
  error?: string;
  hints: Record<string, string>;
}

export const SETUP_TOOL_DEFINITION = {
  name: 'setup',
  description: '[SETUP] Configure GAS project for scripts.run execution. Three operations: init (one-time GCP project setup), script (per-script readiness: GCP switch + manifest + verify), status (check state). Auto-detects operation from context.',
  annotations: {
    title: 'Setup GAS Project for Execution',
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
      operation: {
        type: 'string' as const,
        enum: ['init', 'script', 'status'] as const,
        description: 'Operation: init (GCP project setup), script (per-script readiness), status (check state). Auto-detected if omitted.',
      },
      gcpProjectNumber: {
        type: 'string' as const,
        description: 'Standard GCP project number (e.g. "428972970708"). Falls back to gas-deploy.json _config.gcpProjectNumber.',
      },
    },
    required: [] as string[],
    additionalProperties: false,
    llmGuidance: {
      setup: GuidanceFragments.scriptsRun,
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

export async function handleSetupTool(
  params: SetupToolParams,
  fileOps: GASFileOperations,
  sessionManager: SessionManager,
  chromeDevtools?: ChromeDevtools
): Promise<SetupToolResult> {
  // Resolve localDir for config lookups (may not have scriptId)
  let localDir: string | undefined;
  try {
    if (params.scriptId || params.localDir) {
      const resolved = await resolveProject({
        scriptId: params.scriptId,
        localDir: params.localDir,
      });
      localDir = resolved.localDir;
    }
  } catch {
    localDir = params.localDir;
  }

  // Auto-detect operation
  let operation = params.operation;
  if (!operation) {
    if (params.scriptId) {
      operation = 'script';
    } else {
      const oauthConfig = await loadOAuthConfig();
      operation = oauthConfig ? 'status' : 'init';
    }
  }

  switch (operation) {
    case 'init':
      return handleSetupInit(params, localDir, sessionManager);
    case 'script':
      return handleSetupScript(params, localDir, fileOps, sessionManager, chromeDevtools);
    case 'status':
      return handleSetupStatus(params, localDir, fileOps, sessionManager);
    default:
      return {
        success: false,
        operation: operation as SetupOperation,
        oauthConfig: { present: false },
        token: { present: false },
        gcpProjectNumber: { present: false },
        error: `Unknown operation: ${operation as string}`,
        hints: { fix: 'Use operation="init", "script", or "status".' },
      };
  }
}

async function handleSetupInit(
  params: SetupToolParams,
  localDir: string | undefined,
  sessionManager: SessionManager
): Promise<SetupToolResult> {
  const hints: Record<string, string> = {};

  // 1. Check oauth-config.json
  const oauthConfig = await loadOAuthConfig();
  const oauthStatus: SetupRequirementStatus = oauthConfig
    ? { present: true, value: oauthConfig.client_id }
    : {
        present: false,
        hint: 'Create Desktop App OAuth credentials at console.cloud.google.com > APIs & Services > Credentials > Create > OAuth Client ID > Desktop App. Download JSON to ~/.config/mcp-gas/oauth-config.json',
      };

  if (!oauthConfig) {
    hints.oauthConfig = oauthStatus.hint!;
  }

  // 2. Check token state
  let token: string | null = null;
  let email: string | undefined;
  try {
    token = await sessionManager.getValidToken();
    const userInfo = await (sessionManager as unknown as { getUserInfo?(): Promise<{ email?: string } | null> }).getUserInfo?.();
    email = userInfo?.email;
  } catch {
    token = null;
  }
  const tokenStatus: SetupRequirementStatus = token
    ? { present: true, value: email }
    : {
        present: false,
        hint: await getAuthHint(sessionManager),
      };

  if (!token) {
    hints.auth = tokenStatus.hint!;
  }

  // 3. Check gcpProjectNumber
  let gcpProjectNumber = params.gcpProjectNumber;
  if (!gcpProjectNumber && localDir) {
    try {
      const rootConfig = await getRootConfig(localDir);
      gcpProjectNumber = rootConfig.gcpProjectNumber;
    } catch {
      // Ignore
    }
  }

  if (gcpProjectNumber && !GCP_PROJECT_NUMBER_RE.test(gcpProjectNumber)) {
    return {
      success: false,
      operation: 'init',
      oauthConfig: oauthStatus,
      token: tokenStatus,
      gcpProjectNumber: { present: false },
      error: `Invalid gcpProjectNumber "${gcpProjectNumber}": must be 6–20 digits.`,
      hints: { fix: 'Find your GCP project number at console.cloud.google.com > project settings.' },
    };
  }

  const gcpStatus: SetupRequirementStatus = gcpProjectNumber
    ? { present: true, value: gcpProjectNumber }
    : {
        present: false,
        hint: 'Provide gcpProjectNumber (find at console.cloud.google.com > project settings > Project number).',
      };

  if (!gcpProjectNumber) {
    hints.gcpProjectNumber = gcpStatus.hint!;
  }

  // 4. Best-effort: enable Apps Script API
  let apiEnabled: boolean | 'warning' | undefined;
  let apiEnabledHint: string | undefined;

  if (gcpProjectNumber && token) {
    const apiResult = await enableAppsScriptApi(gcpProjectNumber, token);
    if (apiResult.success) {
      apiEnabled = true;
    } else {
      apiEnabled = 'warning';
      apiEnabledHint = apiResult.hint ?? apiResult.error;
      if (apiEnabledHint) hints.apiEnable = apiEnabledHint;
    }
  }

  // 5. Persist gcpProjectNumber to _config
  if (gcpProjectNumber && localDir) {
    try {
      const existing = await getRootConfig(localDir);
      if (!existing.gcpProjectNumber) {
        await setRootConfig(localDir, { gcpProjectNumber });
      }
    } catch {
      // Non-fatal
    }
  }

  const allPresent = oauthStatus.present && tokenStatus.present && gcpStatus.present;

  if (!allPresent) {
    hints.next = 'Complete the missing requirements above, then re-run setup({operation: "init"}) to verify.';
  } else {
    hints.next = 'Init complete. Run setup({scriptId, operation: "script"}) to make a specific script executable via scripts.run.';
  }

  return {
    success: allPresent,
    operation: 'init',
    oauthConfig: oauthStatus,
    token: tokenStatus,
    gcpProjectNumber: gcpStatus,
    apiEnabled,
    apiEnabledHint,
    hints,
  };
}

async function handleSetupScript(
  params: SetupToolParams,
  localDir: string | undefined,
  fileOps: GASFileOperations,
  sessionManager: SessionManager,
  chromeDevtools?: ChromeDevtools
): Promise<SetupToolResult> {
  const hints: Record<string, string> = {};

  // Need scriptId for script operation
  let scriptId: string | undefined = params.scriptId;
  if (!scriptId && localDir) {
    try {
      const resolved = await resolveProject({ localDir });
      scriptId = resolved.scriptId;
    } catch {
      // Will error below
    }
  }

  if (!scriptId) {
    return {
      success: false,
      operation: 'script',
      oauthConfig: { present: false },
      token: { present: false },
      gcpProjectNumber: { present: false },
      error: 'scriptId is required for setup operation="script".',
      hints: { fix: 'Provide scriptId or point localDir to a directory with .clasp.json.' },
    };
  }

  // Resolve gcpProjectNumber
  let gcpProjectNumber = params.gcpProjectNumber;
  if (!gcpProjectNumber && localDir) {
    try {
      const rootConfig = await getRootConfig(localDir);
      gcpProjectNumber = rootConfig.gcpProjectNumber;
    } catch {
      // Ignore
    }
  }

  if (gcpProjectNumber && !GCP_PROJECT_NUMBER_RE.test(gcpProjectNumber)) {
    return {
      success: false,
      operation: 'script',
      oauthConfig: { present: false },
      token: { present: false },
      gcpProjectNumber: { present: false },
      error: `Invalid gcpProjectNumber "${gcpProjectNumber}": must be 6–20 digits.`,
      hints: { fix: 'Find your GCP project number at console.cloud.google.com > project settings.' },
    };
  }

  if (!gcpProjectNumber) {
    return {
      success: false,
      operation: 'script',
      oauthConfig: { present: false },
      token: { present: false },
      gcpProjectNumber: {
        present: false,
        hint: 'Provide gcpProjectNumber (find at console.cloud.google.com > project settings).',
      },
      error: 'gcpProjectNumber is required for setup operation="script".',
      hints: {
        fix: 'Run setup({scriptId, gcpProjectNumber: "<number>"}) or set it in gas-deploy.json _config.',
      },
    };
  }

  // Check token
  let token: string | null = null;
  let email: string | undefined;
  try {
    token = await sessionManager.getValidToken();
    const userInfo = await (sessionManager as unknown as { getUserInfo?(): Promise<{ email?: string } | null> }).getUserInfo?.();
    email = userInfo?.email;
  } catch {
    token = null;
  }

  if (!token) {
    const hint = await getAuthHint(sessionManager);
    return {
      success: false,
      operation: 'script',
      oauthConfig: { present: false },
      token: { present: false, hint },
      gcpProjectNumber: { present: true, value: gcpProjectNumber },
      error: hint,
      hints: { auth: hint },
    };
  }

  const oauthConfig = await loadOAuthConfig();

  // Check if already set up
  if (localDir) {
    try {
      const deployInfo = await getDeploymentInfo(localDir, scriptId);
      if (deployInfo.gcpSwitched) {
        hints.next = 'Already set up for scripts.run. Run exec({scriptId}) to execute.';
        return {
          success: true,
          operation: 'script',
          scriptId,
          oauthConfig: { present: !!oauthConfig },
          token: { present: true, value: email },
          gcpProjectNumber: { present: true, value: gcpProjectNumber },
          gcpSwitched: { present: true, value: 'already set' },
          scriptsRunVerified: true,
          hints,
        };
      }
    } catch {
      // No config yet — continue
    }
  }

  // GCP switch
  if (!chromeDevtools) {
    hints.chromeDevtools = 'GCP switch requires chrome-devtools MCP server.';
    hints.manual = `To manually switch: open https://script.google.com/home/projects/${scriptId}/settings > GCP Project > Change Project > enter ${gcpProjectNumber}.`;
    return {
      success: false,
      operation: 'script',
      scriptId,
      oauthConfig: { present: !!oauthConfig },
      token: { present: true, value: email },
      gcpProjectNumber: { present: true, value: gcpProjectNumber },
      gcpSwitched: {
        present: false,
        hint: 'chrome-devtools MCP server required for GCP switch. Configure it and retry, or switch manually via Script Editor settings.',
      },
      error: 'chrome-devtools MCP server not available for GCP switch.',
      hints,
    };
  }

  const switchResult = await switchGcpProject(scriptId, gcpProjectNumber, chromeDevtools);
  if (!switchResult.success) {
    return {
      success: false,
      operation: 'script',
      scriptId,
      oauthConfig: { present: !!oauthConfig },
      token: { present: true, value: email },
      gcpProjectNumber: { present: true, value: gcpProjectNumber },
      gcpSwitched: { present: false, hint: switchResult.hint },
      error: switchResult.error ?? 'GCP switch failed',
      hints: switchResult.hint ? { gcpSwitch: switchResult.hint } : {},
    };
  }

  // Ensure executionApi.access in manifest
  let executionApiUpdated = false;
  try {
    const files = await fileOps.getProjectFiles(scriptId);
    const { files: updatedFiles, updated } = ensureExecutionApi(files);
    if (updated) {
      await fileOps.updateProjectFiles(scriptId, updatedFiles);
      executionApiUpdated = true;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    hints.manifest = `Could not update manifest: ${message}. Manually add "executionApi": {"access": "MYSELF"} to appsscript.json.`;
  }

  // Verify with scripts.run
  const verifyResult = await executeViaScriptsRun(scriptId, 'return true', token);
  const scriptsRunVerified = verifyResult.success;

  if (!scriptsRunVerified) {
    hints.verify = `scripts.run verify failed: ${verifyResult.error ?? 'unknown'}. ${verifyResult.hint ?? ''}`;
  }

  // Persist setup state
  if (localDir) {
    try {
      if (scriptsRunVerified) {
        await setDeploymentInfo(localDir, scriptId, { gcpSwitched: true });
      }
      await setRootConfig(localDir, { gcpProjectNumber });
    } catch {
      // Non-fatal
    }
  }

  if (scriptsRunVerified) {
    hints.next = `scripts.run is ready. Run exec({scriptId: "${scriptId}"}) to execute code.`;
  }

  return {
    success: scriptsRunVerified,
    operation: 'script',
    scriptId,
    oauthConfig: { present: !!oauthConfig },
    token: { present: true, value: email },
    gcpProjectNumber: { present: true, value: gcpProjectNumber },
    gcpSwitched: { present: true },
    executionApi: { present: true, value: executionApiUpdated ? 'updated' : 'already set' },
    scriptsRunVerified,
    hints,
  };
}

async function handleSetupStatus(
  params: SetupToolParams,
  localDir: string | undefined,
  fileOps: GASFileOperations,
  sessionManager: SessionManager
): Promise<SetupToolResult> {
  const hints: Record<string, string> = {};

  // 1. Check oauth-config.json
  const oauthConfig = await loadOAuthConfig();
  const oauthStatus: SetupRequirementStatus = oauthConfig
    ? { present: true, value: oauthConfig.client_id }
    : { present: false, hint: 'Place oauth-config.json at ~/.config/mcp-gas/oauth-config.json' };

  if (!oauthConfig) hints.oauthConfig = oauthStatus.hint!;

  // 2. Check token
  let token: string | null = null;
  let email: string | undefined;
  try {
    token = await sessionManager.getValidToken();
    const userInfo = await (sessionManager as unknown as { getUserInfo?(): Promise<{ email?: string } | null> }).getUserInfo?.();
    email = userInfo?.email;
  } catch {
    token = null;
  }
  const tokenStatus: SetupRequirementStatus = token
    ? { present: true, value: email }
    : { present: false, hint: await getAuthHint(sessionManager) };

  if (!token) hints.auth = tokenStatus.hint!;

  // 3. Check gcpProjectNumber
  let gcpProjectNumber = params.gcpProjectNumber;
  if (!gcpProjectNumber && localDir) {
    try {
      const rootConfig = await getRootConfig(localDir);
      gcpProjectNumber = rootConfig.gcpProjectNumber;
    } catch {
      // Ignore
    }
  }
  const gcpStatus: SetupRequirementStatus = gcpProjectNumber
    ? { present: true, value: gcpProjectNumber }
    : { present: false, hint: 'Provide gcpProjectNumber or run setup({operation: "init"}).' };

  if (!gcpProjectNumber) hints.gcpProjectNumber = gcpStatus.hint!;

  // 4. Per-script checks
  const scriptId = params.scriptId;
  let gcpSwitchedStatus: SetupRequirementStatus | undefined;
  let executionApiStatus: SetupRequirementStatus | undefined;
  let scriptsRunVerified: boolean | undefined;

  if (scriptId && localDir) {
    // Check gcpSwitched
    try {
      const deployInfo = await getDeploymentInfo(localDir, scriptId);
      gcpSwitchedStatus = { present: !!deployInfo.gcpSwitched };
    } catch {
      gcpSwitchedStatus = { present: false };
    }

    // Check manifest
    try {
      const files = await fileOps.getProjectFiles(scriptId);
      const manifest = parseManifest(files);
      const executionApiAccess = (manifest?.executionApi as Record<string, unknown> | undefined)?.access;
      executionApiStatus = {
        present: executionApiAccess === 'MYSELF',
        value: executionApiAccess as string | undefined,
        hint: executionApiAccess !== 'MYSELF' ? 'Run setup({operation: "script", scriptId}) to fix.' : undefined,
      };
    } catch {
      executionApiStatus = { present: false, hint: 'Could not read project files.' };
    }

    // Optional quick verify
    if (token) {
      const verifyResult = await executeViaScriptsRun(scriptId, 'return true', token);
      scriptsRunVerified = verifyResult.success;
      if (!verifyResult.success) {
        hints.scriptsRun = `scripts.run not working: ${verifyResult.error ?? 'unknown'}. Run setup({operation: "script", scriptId}) to fix.`;
      }
    }
  }

  const allReady = oauthStatus.present && tokenStatus.present && gcpStatus.present;

  if (allReady && !scriptId) {
    hints.next = 'Project-level setup looks good. Run setup({scriptId, operation: "script"}) to make a specific script executable.';
  } else if (!allReady) {
    hints.next = 'Complete missing requirements then re-run status to verify.';
  }

  return {
    success: allReady,
    operation: 'status',
    scriptId,
    oauthConfig: oauthStatus,
    token: tokenStatus,
    gcpProjectNumber: gcpStatus,
    gcpSwitched: gcpSwitchedStatus,
    executionApi: executionApiStatus,
    scriptsRunVerified,
    hints,
  };
}
