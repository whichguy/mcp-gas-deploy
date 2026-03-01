/**
 * Deploy Tool for mcp-gas-deploy
 *
 * Manages GAS versioned deployments.
 *
 * action=deploy (default): Push files, create version snapshot, pin to staging/prod.
 * action=list-versions: Show all saved version snapshots and remaining budget (cap: 200).
 * action=rollback: Revert a deployment to a prior version without re-pushing files.
 *
 * Stores deployment URLs and active versionNumbers in gas-deploy.json.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { GASDeployOperations } from '../api/gasDeployOperations.js';
import { push } from '../sync/rsync.js';
import {
  getDeploymentInfo,
  setDeploymentInfo,
  type DeploymentInfo,
  STALE_THRESHOLD_MS,
} from '../config/deployConfig.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';
import { generateShimCode, validateUserSymbol, buildConsumerManifest } from '../utils/consumerShim.js';

/** Default web app manifest config — applied when deploying a project with no webapp section. */
const DEFAULT_WEBAPP_CONFIG = {
  executeAs: 'USER_ACCESSING',
  access: 'MYSELF',
} as const;

/**
 * Ensure the local appsscript.json has a webapp section.
 * If missing, injects DEFAULT_WEBAPP_CONFIG so the deployment serves as a web app.
 * Non-throwing — failure is logged and ignored (version creation will proceed regardless).
 */
async function ensureWebAppManifest(localDir: string): Promise<void> {
  const manifestPath = path.join(localDir, 'appsscript.json');
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return; // No local manifest — nothing to inject
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return; // Malformed JSON — leave it as-is
  }

  if (manifest.webapp) return; // Already configured

  manifest.webapp = DEFAULT_WEBAPP_CONFIG;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.error('[deploy] Injected default webapp config into appsscript.json');
}

export interface DeployToolParams {
  scriptId: string;
  localDir?: string;
  action?: 'deploy' | 'list-versions' | 'rollback' | 'promote';
  to?: 'staging' | 'prod';
  from?: 'staging' | 'prod';
  versionNumber?: number;
  description?: string;
}

export interface DeployToolResult {
  success: boolean;
  action: string;
  environment?: string;
  versionNumber?: number;
  previousVersionNumber?: number;
  sourceEnv?: string;
  targetEnv?: string;
  deploymentId?: string;
  webAppUrl?: string;
  versions?: Array<{
    versionNumber: number;
    description?: string;
    createTime?: string;
  }>;
  versionBudget?: {
    used: number;
    remaining: number;
    limit: number;
  };
  consumerUpdate?: {
    scriptId: string;
    versionNumber?: number;
    deploymentUpdated?: boolean;
    error?: string;
  };
  error?: string;
  hints: Record<string, string>;
}

export const DEPLOY_TOOL_DEFINITION = {
  name: 'deploy',
  description: `Manage GAS versioned deployments.

action=deploy (default): Push files and create a versioned web app deployment (staging | prod).
action=list-versions: List all version snapshots and remaining budget (cap: 200 per project).
action=rollback: Revert staging or prod deployment to a prior version (instant, no file push).
action=promote: Re-point target env to source env's existing versionNumber — no new version consumed, no push required.

Pre-deploy: validates CommonJS, pushes all local files. Stores deployment URL for exec.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'Google Apps Script project ID',
      },
      localDir: {
        type: 'string',
        description: 'Local directory with .gs files (default: ~/gas-projects/<scriptId>)',
      },
      action: {
        type: 'string',
        enum: ['deploy', 'list-versions', 'rollback', 'promote'],
        description: 'Action: deploy (default), list-versions, rollback, or promote',
      },
      to: {
        type: 'string',
        enum: ['staging', 'prod'],
        description: 'Target environment — required for deploy, rollback, and promote',
      },
      from: {
        type: 'string',
        enum: ['staging', 'prod'],
        description: 'Source environment — required for promote',
      },
      versionNumber: {
        type: 'number',
        description: 'Version number to roll back to — required for rollback. Use list-versions to see available versions.',
      },
      description: {
        type: 'string',
        description: 'Version description (deploy action only, default: auto-generated)',
      },
    },
    required: ['scriptId'],
  },
};


/**
 * Push shim code + updated manifest to a consumer project, create a version,
 * and optionally update its deployment.
 *
 * Non-fatal by design — caller wraps this in try/catch so consumer errors
 * never fail the source deploy.
 */
async function updateConsumerShim(
  scriptId: string,
  consumerScriptId: string,
  consumerDeploymentId: string | undefined,
  description: string,
  fileOps: GASFileOperations,
  deployOps: GASDeployOperations,
  userSymbol: string
): Promise<{ versionNumber: number; deploymentUpdated: boolean }> {
  // Read source manifest — use empty fallback so consumer shim still builds
  let oauthScopes: string[] | undefined;
  let timeZone: string | undefined;
  try {
    const files = await fileOps.getProjectFiles(scriptId);
    const manifestFile = files.find((f) => f.name === 'appsscript');
    if (manifestFile?.source) {
      const parsed = JSON.parse(manifestFile.source) as Record<string, unknown>;
      oauthScopes = Array.isArray(parsed.oauthScopes) ? (parsed.oauthScopes as string[]) : undefined;
      timeZone = typeof parsed.timeZone === 'string' ? parsed.timeZone : undefined;
    }
  } catch {
    // non-fatal: use empty manifest — consumer manifest will have no oauthScopes/timeZone
  }

  const shimCode = generateShimCode(userSymbol);
  const consumerManifest = buildConsumerManifest(scriptId, userSymbol, oauthScopes, timeZone);

  // Push shim code + manifest to consumer project
  await fileOps.updateProjectFiles(consumerScriptId, [
    { name: 'appsscript', source: JSON.stringify(consumerManifest, null, 2), type: 'JSON' },
    { name: 'Code', source: shimCode, type: 'SERVER_JS' },
  ]);

  // Create consumer version snapshot
  const consumerVersion = await deployOps.createVersion(consumerScriptId, description);
  const consumerVersionNumber = consumerVersion.versionNumber;

  let deploymentUpdated = false;
  if (consumerDeploymentId) {
    await deployOps.updateDeployment(consumerScriptId, consumerDeploymentId, consumerVersionNumber);
    deploymentUpdated = true;
  }

  return { versionNumber: consumerVersionNumber, deploymentUpdated };
}

export async function handleDeployTool(
  params: DeployToolParams,
  fileOps: GASFileOperations,
  deployOps: GASDeployOperations
): Promise<DeployToolResult> {
  const { scriptId, localDir, action = 'deploy', to, from, description, versionNumber } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false, action,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  const resolvedDir = localDir
    ? path.resolve(localDir)
    : path.join(os.homedir(), 'gas-projects', scriptId);

  if (localDir && !resolvedDir.startsWith(os.homedir() + path.sep)) {
    return {
      success: false, action,
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
    };
  }

  // --- action: list-versions ---
  if (action === 'list-versions') {
    try {
      const versions = await deployOps.listVersions(scriptId);
      const limit = 200;
      const used = versions.length;
      return {
        success: true,
        action: 'list-versions',
        versions: versions.map(v => ({
          versionNumber: v.versionNumber,
          description: v.description,
          createTime: v.createTime,
        })),
        versionBudget: { used, remaining: limit - used, limit },
        hints: {
          next: `${used} version(s) used (${limit - used} remaining of ${limit} cap). Use action=rollback with versionNumber to revert.`,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        action: 'list-versions',
        error: `Failed to list versions: ${message}`,
        hints: { fix: 'Check authentication and project permissions' },
      };
    }
  }

  // --- action: rollback ---
  if (action === 'rollback') {
    if (!to) {
      return {
        success: false, action,
        error: 'to (staging|prod) is required for rollback',
        hints: { fix: 'Specify to="staging" or to="prod"' },
      };
    }

    if (versionNumber == null) {
      return {
        success: false, action,
        environment: to,
        error: 'versionNumber is required for rollback',
        hints: { fix: 'Specify versionNumber — use action=list-versions to see available versions' },
      };
    }

    try {
      const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
      const deploymentIdKey = to === 'staging' ? 'stagingDeploymentId' : 'prodDeploymentId';
      const existingDeploymentId = deployInfo[deploymentIdKey];

      if (!existingDeploymentId) {
        return {
          success: false, action,
          environment: to,
          error: `No ${to} deployment found. Run deploy with action=deploy and to="${to}" first.`,
          hints: { fix: `Run deploy with action=deploy and to="${to}" to create a deployment` },
        };
      }

      // Rollback: patch the deployment to point to versionNumber.
      // This is instant — no file push, no version budget consumed.
      const updated = await deployOps.updateDeployment(scriptId, existingDeploymentId, versionNumber);

      // Update gas-deploy.json to record the active version for this env.
      const updateInfo: Partial<DeploymentInfo> = {};
      if (to === 'staging') {
        updateInfo.stagingVersionNumber = versionNumber;
        if (updated.webAppUrl) updateInfo.stagingUrl = updated.webAppUrl;
      } else {
        updateInfo.prodVersionNumber = versionNumber;
        if (updated.webAppUrl) updateInfo.prodUrl = updated.webAppUrl;
      }
      await setDeploymentInfo(resolvedDir, scriptId, updateInfo);

      return {
        success: true,
        action: 'rollback',
        environment: to,
        versionNumber,
        deploymentId: existingDeploymentId,
        webAppUrl: updated.webAppUrl,
        hints: {
          next: `Rolled back ${to} to v${versionNumber}. HEAD deployment is unchanged — exec still runs the latest local code.`,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false, action,
        environment: to,
        error: `Rollback failed: ${message}`,
        hints: { fix: 'Check that the versionNumber exists. Use action=list-versions to see available versions.' },
      };
    }
  }

  // promote: re-point target deployment to source's existing versionNumber — no new version consumed
  if (action === 'promote') {
    if (!from) {
      return {
        success: false, action,
        error: 'from (staging|prod) is required for promote',
        hints: { fix: 'Specify from="staging" or from="prod"' },
      };
    }
    if (!to) {
      return {
        success: false, action,
        error: 'to (staging|prod) is required for promote',
        hints: { fix: 'Specify to="staging" or to="prod"' },
      };
    }
    if (from === to) {
      return {
        success: false, action,
        error: 'from and to must differ',
        hints: { fix: 'Specify different environments for from and to' },
      };
    }

    try {
      const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);

      const sourceDeploymentIdKey = from === 'staging' ? 'stagingDeploymentId' : 'prodDeploymentId';
      const sourceDeploymentId = deployInfo[sourceDeploymentIdKey];
      if (!sourceDeploymentId) {
        return {
          success: false, action,
          error: `No ${from} deployment found. Run deploy with action=deploy and to="${from}" first.`,
          hints: { fix: `Deploy to ${from} first before promoting from it` },
        };
      }

      const targetDeploymentIdKey = to === 'staging' ? 'stagingDeploymentId' : 'prodDeploymentId';
      const targetDeploymentId = deployInfo[targetDeploymentIdKey];
      if (!targetDeploymentId) {
        return {
          success: false, action,
          error: `No ${to} deployment found. Run deploy with action=deploy and to="${to}" first.`,
          hints: { fix: `Deploy to ${to} first before promoting into it` },
        };
      }

      // Read source versionNumber — throws if HEAD-only
      const sourceVersionNumber = await deployOps.getDeploymentVersionNumber(scriptId, sourceDeploymentId);

      // Capture previous target versionNumber for rollback recovery in response
      const prevVersionNumberKey = to === 'staging' ? 'stagingVersionNumber' : 'prodVersionNumber';
      const previousVersionNumber = deployInfo[prevVersionNumberKey];

      // Capture source env's timestamp BEFORE write for staleness hint
      const prevSourceTs = from === 'staging' ? deployInfo.stagingDeployedAt : deployInfo.prodDeployedAt;

      // Re-point target deployment to source's versionNumber
      const updated = await deployOps.updateDeployment(scriptId, targetDeploymentId, sourceVersionNumber);

      // Write gas-deploy.json: target env versionNumber + timestamp
      const tsField = to === 'staging' ? 'stagingDeployedAt' : 'prodDeployedAt';
      const versionNumberField = to === 'staging' ? 'stagingVersionNumber' : 'prodVersionNumber';
      const updateInfo: Partial<DeploymentInfo> = {
        [versionNumberField]: sourceVersionNumber,
        [tsField]: updated.updateTime ?? new Date().toISOString(),
      };
      if (updated.webAppUrl) {
        const urlField = to === 'staging' ? 'stagingUrl' : 'prodUrl';
        updateInfo[urlField] = updated.webAppUrl;
      }
      // GAS side is done — write local config. If this fails, the promote still succeeded.
      const hints: Record<string, string> = {
        next: `Promoted v${sourceVersionNumber} from ${from} → ${to}. URL: ${updated.webAppUrl ?? targetDeploymentId}.`,
        rollback: previousVersionNumber != null
          ? `To undo: action=rollback to="${to}" versionNumber=${previousVersionNumber}`
          : `No previous version recorded for ${to}.`,
      };
      try {
        await setDeploymentInfo(resolvedDir, scriptId, updateInfo);
      } catch (configErr: unknown) {
        const msg = configErr instanceof Error ? configErr.message : String(configErr);
        hints.warning = `GAS promote succeeded but gas-deploy.json update failed: ${msg}`;
      }

      // Staleness hint: if we just promoted to prod, check whether staging is now stale
      if (to === 'prod' && prevSourceTs) {
        const now = Date.now();
        const stagingAge = now - new Date(prevSourceTs).getTime();
        if (stagingAge > STALE_THRESHOLD_MS) {
          const h = Math.round(stagingAge / (60 * 60 * 1000));
          hints.stale = `staging is ${h}h old — consider re-deploying staging with fresh changes`;
        }
      }

      return {
        success: true,
        action: 'promote',
        versionNumber: sourceVersionNumber,
        previousVersionNumber,
        sourceEnv: from,
        targetEnv: to,
        deploymentId: targetDeploymentId,
        webAppUrl: updated.webAppUrl,
        hints,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false, action,
        error: `Promote failed: ${message}`,
        hints: { fix: 'Check authentication and that both environments have deployments in gas-deploy.json' },
      };
    }
  }

  // --- action: deploy (default) ---
  if (!to) {
    return {
      success: false, action,
      error: 'to (staging|prod) is required for deploy',
      hints: { fix: 'Specify to="staging" or to="prod"' },
    };
  }

  // Inject default webapp config if not present — must happen before sync so it gets pushed with the version.
  try {
    await ensureWebAppManifest(resolvedDir);
  } catch {
    // Non-blocking — proceed without webapp config injection
  }

  // Pre-deploy: push all local files unconditionally
  try {
    const pushResult = await push(scriptId, resolvedDir, fileOps);

    if (!pushResult.success) {
      return {
        success: false, action, environment: to,
        error: `Pre-deploy push failed: ${pushResult.error}`,
        hints: { fix: 'Fix validation errors or check authentication, then retry deploy' },
      };
    }
  } catch (error: unknown) {
    // If localDir doesn't exist, continue — deploy works from remote state
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pre-deploy push skipped: ${message}`);
  }

  // Deploy lifecycle (post-push): create version snapshot → find/update or create
  // web app deployment → pin to version → cache URL in gas-deploy.json.
  try {
    // Create version snapshot
    const versionDesc = description ?? `${to} deploy by mcp-gas-deploy`;
    const version = await deployOps.createVersion(scriptId, versionDesc);

    // Find or create the deployment for this environment
    const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
    const deploymentIdKey = to === 'staging' ? 'stagingDeploymentId' : 'prodDeploymentId';
    const existingDeploymentId = deployInfo[deploymentIdKey];

    let deploymentId: string;
    let webAppUrl: string | undefined;
    let deployUpdateTime: string | undefined;

    if (existingDeploymentId) {
      // Update existing deployment to new version
      const updated = await deployOps.updateDeployment(scriptId, existingDeploymentId, version.versionNumber);
      deploymentId = updated.deploymentId;
      webAppUrl = updated.webAppUrl;
      deployUpdateTime = updated.updateTime;
    } else {
      // Find a web app deployment to reuse, or create a new one
      const deployments = await deployOps.listDeployments(scriptId);
      const webAppDeployment = deployments.find(d =>
        d.entryPoints?.some(ep => ep.entryPointType === 'WEB_APP')
      );

      if (webAppDeployment) {
        // Reuse existing web app deployment
        const updated = await deployOps.updateDeployment(scriptId, webAppDeployment.deploymentId, version.versionNumber);
        deploymentId = updated.deploymentId;
        webAppUrl = updated.webAppUrl;
        deployUpdateTime = updated.updateTime;
      } else {
        // Create new deployment
        const created = await deployOps.createDeployment(scriptId, version.versionNumber, `${to} deployment`);
        deploymentId = created.deploymentId;
        webAppUrl = created.webAppUrl;
        deployUpdateTime = created.updateTime;
      }
    }

    // Capture opposite env's timestamp BEFORE setDeploymentInfo mutates info (for staleness hint)
    const prevProdDeployedAt = to === 'staging' ? deployInfo.prodDeployedAt : undefined;

    // Store deployment info — use GAS API's authoritative updateTime; fall back to client clock
    const tsField = to === 'staging' ? 'stagingDeployedAt' : 'prodDeployedAt';
    const updateInfo: Partial<DeploymentInfo> = {
      lastDeploy: new Date().toISOString(),
      [tsField]: deployUpdateTime ?? new Date().toISOString(),
    };

    if (to === 'staging') {
      updateInfo.stagingDeploymentId = deploymentId;
      updateInfo.stagingVersionNumber = version.versionNumber;
      if (webAppUrl) updateInfo.stagingUrl = webAppUrl;
    } else {
      updateInfo.prodDeploymentId = deploymentId;
      updateInfo.prodVersionNumber = version.versionNumber;
      if (webAppUrl) updateInfo.prodUrl = webAppUrl;
    }

    await setDeploymentInfo(resolvedDir, scriptId, updateInfo);

    // Staleness hint: prod stale vs staging
    const hints: Record<string, string> = {
      next: webAppUrl
        ? `Deployed to ${to} (v${version.versionNumber}). URL: ${webAppUrl}. Run \`exec\` to verify.`
        : `Version ${version.versionNumber} deployed to ${to}. Deployment ID: ${deploymentId}.`,
    };

    const now = Date.now();
    if (to === 'staging') {
      const stagingTs = updateInfo[tsField] as string;
      if (prevProdDeployedAt) {
        const prodAge = now - new Date(prevProdDeployedAt).getTime();
        const stagingAge = now - new Date(stagingTs).getTime();
        if (!isNaN(prodAge) && !isNaN(stagingAge)
            && stagingAge < prodAge && prodAge > STALE_THRESHOLD_MS) {
          const h = Math.round(prodAge / (60 * 60 * 1000));
          hints.stale = `prod is ${h}h behind staging (v${version.versionNumber}) — consider: action=promote from=staging to=prod`;
        }
      }
    }
    // No stale hint when deploying to prod — prod just caught up

    const response: DeployToolResult = {
      success: true,
      action: 'deploy',
      environment: to,
      versionNumber: version.versionNumber,
      deploymentId,
      webAppUrl,
      hints,
    };

    // Consumer shim update — non-fatal: consumer failure must not fail the source deploy
    const consumerScriptId = deployInfo[to === 'staging' ? 'stagingConsumerScriptId' : 'prodConsumerScriptId'];
    const userSymbol = deployInfo.userSymbol;

    if (consumerScriptId && !userSymbol) {
      hints.consumerSkipped = `Consumer shim skipped — userSymbol is not set in gas-deploy.json`;
    } else if (userSymbol && !consumerScriptId) {
      hints.consumerSkipped = `Consumer shim skipped — ${to}ConsumerScriptId is not set in gas-deploy.json`;
    } else if (consumerScriptId && userSymbol) {
      try {
        validateUserSymbol(userSymbol);
        const consumerDeploymentId = deployInfo[to === 'staging' ? 'stagingConsumerDeploymentId' : 'prodConsumerDeploymentId'];
        const consumerResult = await updateConsumerShim(
          scriptId, consumerScriptId, consumerDeploymentId,
          description ?? `Deploy to ${to}`,
          fileOps, deployOps, userSymbol
        );
        response.consumerUpdate = {
          scriptId: consumerScriptId,
          versionNumber: consumerResult.versionNumber,
          deploymentUpdated: consumerResult.deploymentUpdated,
        };
      } catch (consumerError: unknown) {
        // non-fatal: consumer failure must not fail the source deploy
        const msg = consumerError instanceof Error ? consumerError.message : String(consumerError);
        response.consumerUpdate = { scriptId: consumerScriptId, error: `non-fatal: ${msg}` };
      }
    }

    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, action, environment: to,
      error: `Deploy failed: ${message}`,
      hints: { fix: 'Check authentication and project permissions. If deploy failed after version creation, re-run deploy to re-pin.' },
    };
  }
}
