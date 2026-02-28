/**
 * Deploy Tool for mcp-gas-deploy
 *
 * Creates a version snapshot and pins a web app deployment (staging/prod).
 * Pre-deploy: validates + pushes all local files unconditionally.
 * Stores deployment URLs in gas-deploy.json.
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
  to: 'staging' | 'prod';
  description?: string;
}

export interface DeployToolResult {
  success: boolean;
  environment: string;
  versionNumber?: number;
  deploymentId?: string;
  webAppUrl?: string;
  error?: string;
  hints: Record<string, string>;
}

export const DEPLOY_TOOL_DEFINITION = {
  name: 'deploy',
  description: `Create a version snapshot and pin a web app deployment (staging or prod).

Pre-deploy: validates CommonJS and pushes all local files unconditionally.
Stores deployment URLs in local gas-deploy.json for use by exec.`,
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
      to: {
        type: 'string',
        enum: ['staging', 'prod'],
        description: 'Target environment: staging or prod',
      },
      description: {
        type: 'string',
        description: 'Version description (default: auto-generated)',
      },
    },
    required: ['scriptId', 'to'],
  },
};

export async function handleDeployTool(
  params: DeployToolParams,
  fileOps: GASFileOperations,
  deployOps: GASDeployOperations
): Promise<DeployToolResult> {
  const { scriptId, localDir, to, description } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false, environment: to,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  const resolvedDir = localDir
    ? path.resolve(localDir)
    : path.join(os.homedir(), 'gas-projects', scriptId);

  if (localDir && !resolvedDir.startsWith(os.homedir() + path.sep)) {
    return {
      success: false, environment: to,
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
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
        success: false, environment: to,
        error: `Pre-deploy push failed: ${pushResult.error}`,
        hints: { fix: 'Fix validation errors or check authentication, then retry deploy' },
      };
    }
  } catch (error: unknown) {
    // If localDir doesn't exist, continue — deploy works from remote state
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pre-deploy push skipped: ${message}`);
  }

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
      environment: to,
      versionNumber: version.versionNumber,
      deploymentId,
      webAppUrl,
      hints: {
        next: webAppUrl
          ? `Deployed to ${to} (v${version.versionNumber}). URL: ${webAppUrl}. Run \`exec\` to verify.`
          : `Version ${version.versionNumber} deployed to ${to}. Deployment ID: ${deploymentId}.`,
        commonjs: 'GAS CommonJS: function _main(){ exports.fn=function(){...}; } __defineModule__(_main,false);',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, environment: to,
      error: `Deploy failed: ${message}`,
      hints: { fix: 'Check authentication and project permissions. If deploy failed after version creation, re-run deploy to re-pin.' },
    };
  }
}
