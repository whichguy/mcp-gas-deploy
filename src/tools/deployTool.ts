/**
 * Deploy Tool for mcp-gas-deploy
 *
 * Creates a version snapshot and pins a web app deployment (staging/prod).
 * Pre-deploy: validates + pushes if local is ahead.
 * Stores deployment URLs in gas-deploy.json.
 */

import path from 'node:path';
import os from 'node:os';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { GASDeployOperations } from '../api/gasDeployOperations.js';
import { getStatus, push } from '../sync/rsync.js';
import {
  getDeploymentInfo,
  setDeploymentInfo,
  type DeploymentInfo,
} from '../config/deployConfig.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';

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
  syncedBeforeDeploy: boolean;
  error?: string;
  hints: Record<string, string>;
}

export const DEPLOY_TOOL_DEFINITION = {
  name: 'deploy',
  description: `Create a version snapshot and pin a web app deployment (staging or prod).

Pre-deploy: validates CommonJS and pushes changed files if needed.
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
      success: false, environment: to, syncedBeforeDeploy: false,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  const resolvedDir = localDir
    ? path.resolve(localDir)
    : path.join(os.homedir(), 'gas-projects', scriptId);

  if (localDir && !resolvedDir.startsWith(os.homedir())) {
    return {
      success: false, environment: to, syncedBeforeDeploy: false,
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
    };
  }

  // Pre-deploy: check sync status and push if needed
  let syncedBeforeDeploy = false;

  try {
    const status = await getStatus(scriptId, resolvedDir, fileOps);

    // Divergence guard
    if (status.localAhead.length > 0 && status.remoteAhead.length > 0) {
      return {
        success: false, environment: to, syncedBeforeDeploy: false,
        error: 'Remote has changes not in your local copy — run `pull` first to merge, then retry',
        hints: { fix: 'Your local and remote have diverged. Pull remote changes first.' },
      };
    }

    if (status.localAhead.length > 0 || status.localOnly.length > 0) {
      const pushResult = await push(scriptId, resolvedDir, fileOps);

      if (!pushResult.success) {
        return {
          success: false, environment: to, syncedBeforeDeploy: false,
          error: `Pre-deploy push failed: ${pushResult.error}`,
          hints: { fix: 'Fix validation errors or check authentication, then retry deploy' },
        };
      }

      syncedBeforeDeploy = true;
    }
  } catch (error: unknown) {
    // If localDir doesn't exist, continue — deploy works from remote state
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pre-deploy sync check skipped: ${message}`);
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
      syncedBeforeDeploy,
      hints: {
        next: webAppUrl
          ? `Deployed to ${to} (v${version.versionNumber}). URL: ${webAppUrl}. Run \`exec\` to verify.`
          : `Version ${version.versionNumber} deployed to ${to}. Deployment ID: ${deploymentId}.`,
        commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, environment: to, syncedBeforeDeploy,
      error: `Deploy failed: ${message}`,
      hints: { fix: 'Check authentication and project permissions. If deploy failed after version creation, re-run deploy to re-pin.' },
    };
  }
}
