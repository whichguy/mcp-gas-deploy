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
} from '../config/deployConfig.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';

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
  action?: 'deploy' | 'list-versions' | 'rollback';
  to?: 'staging' | 'prod';
  versionNumber?: number;
  description?: string;
}

export interface DeployToolResult {
  success: boolean;
  action: string;
  environment?: string;
  versionNumber?: number;
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
  error?: string;
  hints: Record<string, string>;
}

export const DEPLOY_TOOL_DEFINITION = {
  name: 'deploy',
  description: `Manage GAS versioned deployments.

action=deploy (default): Push files and create a versioned web app deployment (staging | prod).
action=list-versions: List all version snapshots and remaining budget (cap: 200 per project).
action=rollback: Revert staging or prod deployment to a prior version (instant, no file push).

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
        enum: ['deploy', 'list-versions', 'rollback'],
        description: 'Action: deploy (default), list-versions, or rollback',
      },
      to: {
        type: 'string',
        enum: ['staging', 'prod'],
        description: 'Target environment — required for deploy and rollback',
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

export async function handleDeployTool(
  params: DeployToolParams,
  fileOps: GASFileOperations,
  deployOps: GASDeployOperations
): Promise<DeployToolResult> {
  const { scriptId, localDir, action = 'deploy', to, description, versionNumber } = params;

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

    if (existingDeploymentId) {
      // Update existing deployment to new version
      const updated = await deployOps.updateDeployment(scriptId, existingDeploymentId, version.versionNumber);
      deploymentId = updated.deploymentId;
      webAppUrl = updated.webAppUrl;
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
      } else {
        // Create new deployment
        const created = await deployOps.createDeployment(scriptId, version.versionNumber, `${to} deployment`);
        deploymentId = created.deploymentId;
        webAppUrl = created.webAppUrl;
      }
    }

    // Store deployment info
    const updateInfo: Partial<DeploymentInfo> = { lastDeploy: new Date().toISOString() };

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

    return {
      success: true,
      action: 'deploy',
      environment: to,
      versionNumber: version.versionNumber,
      deploymentId,
      webAppUrl,
      hints: {
        next: webAppUrl
          ? `Deployed to ${to} (v${version.versionNumber}). URL: ${webAppUrl}. Run \`exec\` to verify.`
          : `Version ${version.versionNumber} deployed to ${to}. Deployment ID: ${deploymentId}.`,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, action, environment: to,
      error: `Deploy failed: ${message}`,
      hints: { fix: 'Check authentication and project permissions. If deploy failed after version creation, re-run deploy to re-pin.' },
    };
  }
}
