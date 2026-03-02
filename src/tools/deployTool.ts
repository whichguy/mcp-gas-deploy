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

action=deploy (default): Push files and create a versioned web app deployment to staging. Maintains a 4-slot circular buffer for rollback history.
action=list-versions: List all version snapshots and remaining budget (cap: 200 per project).
action=rollback: Revert staging or prod deployment one step back in the circular buffer (instant, no file push). Use to=staging or to=prod.
action=promote: Promote staging to prod — re-points the prod deployment to the current staging version. Always staging→prod.

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
        description: 'Target environment — required for rollback (staging|prod)',
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
 * Returns the index (0-based) of the slot to write on the next deploy.
 * Priority:
 *   1. Lowest-numbered undeployed slot: if fewer than 4 slots exist, returns slotDescriptions.length
 *      (fills slots in order: index 0 first = "slot 1", then 1, 2, 3 = "slot 4")
 *   2. All 4 slots deployed: returns index with the oldest ISO description timestamp
 *
 * Note: concurrent deploys for the same scriptId will collide on slot selection — callers must serialize
 * Note: partial-failure retries may orphan a GAS deployment slot — safe to ignore, overwritten on next full buffer rotation
 */
function findNextSlotIndex(slotDescriptions: string[] | undefined): number {
  if (!slotDescriptions || slotDescriptions.length < 4) {
    return slotDescriptions?.length ?? 0;
  }
  let minIdx = 0;
  for (let i = 1; i < slotDescriptions.length; i++) {
    if (slotDescriptions[i] < slotDescriptions[minIdx]) minIdx = i;
  }
  return minIdx;
}

/**
 * Returns the index of the previous slot (one step earlier in deployment order),
 * or null if the active slot is already the oldest.
 * ISO string lexicographic comparison is correct for UTC timestamps.
 * Rollback is strictly linear — does not wrap around (hard stop at oldest deployed slot).
 */
function findPrevSlotIndex(
  slotDescriptions: string[],
  activeIndex: number
): number | null {
  const sorted = slotDescriptions
    .map((desc, i) => ({ i, desc }))
    .sort((a, b) => a.desc.localeCompare(b.desc));
  const pos = sorted.findIndex(s => s.i === activeIndex);
  if (pos <= 0) return null; // already at oldest
  return sorted[pos - 1].i;
}

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
  userSymbol: string,
  sourceVersionNumber: number
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
  // Pin consumer to the exact source version just deployed (developmentMode: false)
  // so it runs against the tested snapshot, not whatever HEAD is at runtime.
  const consumerManifest = buildConsumerManifest(scriptId, userSymbol, oauthScopes, timeZone, sourceVersionNumber);

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
  const { scriptId, localDir, action = 'deploy', to, description } = params;

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
          next: `${used} version(s) used (${limit - used} remaining of ${limit} cap). Use action=rollback with to="staging" or to="prod" to step back one slot.`,
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

  // --- action: rollback (slot-based — walks one step back in circular buffer) ---
  if (action === 'rollback') {
    if (!to || (to !== 'staging' && to !== 'prod')) {
      return {
        success: false, action,
        error: `Invalid environment: ${to ?? '(not specified)'} — rollback requires to="staging" or to="prod"`,
        hints: { fix: 'Specify to="staging" or to="prod"' },
      };
    }

    try {
      const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);

      // Read slot data using typed branching — required under strict TypeScript
      const isStagingEnv = to === 'staging';
      const slotDescriptions = (isStagingEnv ? deployInfo.stagingSlotDescriptions : deployInfo.prodSlotDescriptions) ?? [];
      const slotVersions = (isStagingEnv ? deployInfo.stagingSlotVersions : deployInfo.prodSlotVersions) ?? [];
      const activeIndex = (isStagingEnv ? deployInfo.stagingActiveSlotIndex : deployInfo.prodActiveSlotIndex) ?? 0;
      const pointerDeploymentId = isStagingEnv ? deployInfo.stagingDeploymentId : deployInfo.prodDeploymentId;

      if (slotDescriptions.length === 0) {
        return {
          success: false, action, environment: to,
          error: 'No rollback slots available — run deploy first to establish the slot buffer',
          hints: { fix: 'Run action=deploy to create the first deployment slot' },
        };
      }

      const prevIndex = findPrevSlotIndex(slotDescriptions, activeIndex);
      if (prevIndex === null) {
        return {
          success: false, action, environment: to,
          error: 'Already at oldest available version — no earlier slot in the buffer',
          hints: { next: 'No earlier slot available. Deploy a new version to extend rollback history.' },
        };
      }

      const effectiveVersion = slotVersions[prevIndex];
      if (effectiveVersion == null) {
        return {
          success: false, action, environment: to,
          error: 'Rollback slot data incomplete — run deploy to rebuild the buffer',
          hints: { fix: 'Run action=deploy to rebuild slot data' },
        };
      }

      if (!pointerDeploymentId) {
        return {
          success: false, action, environment: to,
          error: `No ${to} pointer deployment found — run deploy first`,
          hints: { fix: 'Run action=deploy to create the pointer deployment' },
        };
      }

      // Roll back source pointer — no description update on pointer
      await deployOps.updateDeployment(scriptId, pointerDeploymentId, effectiveVersion);

      const response: DeployToolResult = {
        success: true,
        action: 'rollback',
        environment: to,
        versionNumber: effectiveVersion,
        deploymentId: pointerDeploymentId,
        hints: {
          next: `Rolled back ${to} to v${effectiveVersion}. HEAD deployment is unchanged — exec still runs the latest local code.`,
        },
      };

      // Roll back consumer — push FRESH shim pinned to effectiveVersion (non-fatal)
      // Always push current shim template with source version pinned — do NOT revert old shim code.
      try {
        const consumerScriptId = isStagingEnv ? deployInfo.stagingConsumerScriptId : deployInfo.prodConsumerScriptId;
        const consumerDeploymentId = isStagingEnv ? deployInfo.stagingConsumerDeploymentId : deployInfo.prodConsumerDeploymentId;
        const userSymbol = deployInfo.userSymbol;
        if (consumerScriptId && consumerDeploymentId && userSymbol) {
          validateUserSymbol(userSymbol);
          const consumerResult = await updateConsumerShim(
            scriptId, consumerScriptId, consumerDeploymentId,
            `rollback to v${effectiveVersion}`, fileOps, deployOps, userSymbol, effectiveVersion
          );
          response.consumerUpdate = {
            scriptId: consumerScriptId,
            versionNumber: consumerResult.versionNumber,
            deploymentUpdated: consumerResult.deploymentUpdated,
          };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const consumerScriptId = isStagingEnv ? deployInfo.stagingConsumerScriptId : deployInfo.prodConsumerScriptId;
        response.consumerUpdate = { scriptId: consumerScriptId ?? '', error: `non-fatal: ${msg}` };
      }

      // Update gas-deploy.json — slot arrays NOT modified; only active index + version number change
      // Invariant: gas-deploy.json written only after source pointer update succeeds; consumer failure is non-fatal
      const updateInfo: Partial<DeploymentInfo> = {};
      if (isStagingEnv) {
        updateInfo.stagingActiveSlotIndex = prevIndex;
        updateInfo.stagingVersionNumber = effectiveVersion;
      } else {
        updateInfo.prodActiveSlotIndex = prevIndex;
        updateInfo.prodVersionNumber = effectiveVersion;
      }
      // Rollback does not modify consumer slot arrays — consumer update is handled non-fatally above.
      await setDeploymentInfo(resolvedDir, scriptId, updateInfo);

      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false, action,
        environment: to,
        error: `Rollback failed: ${message}`,
        hints: { fix: 'Check authentication and project permissions.' },
      };
    }
  }

  // promote: always staging → prod — no from/to params; always staging→prod by design
  if (action === 'promote') {
    try {
      const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);

      const stagingDeploymentId = deployInfo.stagingDeploymentId;
      if (!stagingDeploymentId) {
        return {
          success: false, action,
          error: 'No staging deployment found — run deploy first to create a staging deployment',
          hints: { fix: 'Run action=deploy to create the staging deployment' },
        };
      }

      const prodDeploymentId = deployInfo.prodDeploymentId;
      if (!prodDeploymentId) {
        return {
          success: false, action,
          error: 'No prod deployment found — create an initial prod deployment first',
          hints: { fix: 'Create a prod deployment ID in gas-deploy.json or run an initial prod deploy' },
        };
      }

      // Read source versionNumber from staging — throws if HEAD-only
      const sourceVersionNumber = await deployOps.getDeploymentVersionNumber(scriptId, stagingDeploymentId);

      // Capture previous prod versionNumber for rollback hint
      const previousVersionNumber = deployInfo.prodVersionNumber;

      // Capture staging timestamp BEFORE write for staleness hint
      const prevStagingTs = deployInfo.stagingDeployedAt;

      // Re-point prod deployment to staging's versionNumber
      const updated = await deployOps.updateDeployment(scriptId, prodDeploymentId, sourceVersionNumber);

      const ISO_NOW = updated.updateTime ?? new Date().toISOString();

      // Write gas-deploy.json after prod pointer update succeeds
      const updateInfo: Partial<DeploymentInfo> = {
        prodVersionNumber: sourceVersionNumber,
        prodDeployedAt: ISO_NOW,
      };
      if (updated.webAppUrl) updateInfo.prodUrl = updated.webAppUrl;

      const response: DeployToolResult = {
        success: true,
        action: 'promote',
        versionNumber: sourceVersionNumber,
        previousVersionNumber,
        sourceEnv: 'staging',
        targetEnv: 'prod',
        deploymentId: prodDeploymentId,
        webAppUrl: updated.webAppUrl,
        hints: {},
      };

      // Step 1 — Write to prod source slot (Track B)
      const ISO_SLOT_NOW = new Date().toISOString();
      const prodSlotIndex = findNextSlotIndex(deployInfo.prodSlotDescriptions);
      const prodSlotIds = [...(deployInfo.prodSlotIds ?? [])];

      if (prodSlotIndex >= prodSlotIds.length) {
        const newSlot = await deployOps.createDeployment(scriptId, sourceVersionNumber, ISO_SLOT_NOW);
        prodSlotIds.push(newSlot.deploymentId);
      } else {
        await deployOps.updateDeployment(scriptId, prodSlotIds[prodSlotIndex], sourceVersionNumber, ISO_SLOT_NOW);
      }

      updateInfo.prodSlotIds = prodSlotIds;
      const updatedProdSlotVersions = [...(deployInfo.prodSlotVersions ?? [])];
      updatedProdSlotVersions[prodSlotIndex] = sourceVersionNumber;
      updateInfo.prodSlotVersions = updatedProdSlotVersions;
      const updatedProdSlotDescriptions = [...(deployInfo.prodSlotDescriptions ?? [])];
      updatedProdSlotDescriptions[prodSlotIndex] = ISO_SLOT_NOW;
      updateInfo.prodSlotDescriptions = updatedProdSlotDescriptions;
      updateInfo.prodActiveSlotIndex = prodSlotIndex;

      // Step 2 — Consumer update (Track A, non-fatal)
      const prodConsumerScriptId = deployInfo.prodConsumerScriptId;
      const prodConsumerDeploymentId = deployInfo.prodConsumerDeploymentId;
      const userSymbol = deployInfo.userSymbol;

      if (prodConsumerScriptId && userSymbol) {
        try {
          validateUserSymbol(userSymbol);
          const consumerResult = await updateConsumerShim(
            scriptId, prodConsumerScriptId, prodConsumerDeploymentId,
            'prod consumer promote', fileOps, deployOps, userSymbol, sourceVersionNumber
          );
          const updatedProdSlotConsumerVersions = [...(deployInfo.prodSlotConsumerVersions ?? [])];
          updatedProdSlotConsumerVersions[prodSlotIndex] = consumerResult.versionNumber ?? null;
          updateInfo.prodSlotConsumerVersions = updatedProdSlotConsumerVersions;
          response.consumerUpdate = {
            scriptId: prodConsumerScriptId,
            versionNumber: consumerResult.versionNumber,
            deploymentUpdated: consumerResult.deploymentUpdated,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          response.consumerUpdate = { scriptId: prodConsumerScriptId, error: `non-fatal: ${msg}` };
        }
      } else if (prodConsumerScriptId && !userSymbol) {
        response.hints.consumerSkipped = 'Consumer shim skipped — userSymbol is not set in gas-deploy.json';
      }

      // GAS side is done — write local config. If this fails, the promote still succeeded.
      response.hints.next = `Promoted v${sourceVersionNumber} from staging → prod. URL: ${updated.webAppUrl ?? prodDeploymentId}.`;
      response.hints.rollback = previousVersionNumber != null
        ? `To undo: action=rollback to="prod"`
        : `No previous version recorded for prod.`;

      try {
        await setDeploymentInfo(resolvedDir, scriptId, updateInfo);
      } catch (configErr: unknown) {
        const msg = configErr instanceof Error ? configErr.message : String(configErr);
        response.hints.warning = `GAS promote succeeded but gas-deploy.json update failed: ${msg}`;
      }

      // Staleness hint: check whether staging is now stale
      if (prevStagingTs) {
        const nowMs = Date.now();
        const stagingAge = nowMs - new Date(prevStagingTs).getTime();
        if (stagingAge > STALE_THRESHOLD_MS) {
          const h = Math.round(stagingAge / (60 * 60 * 1000));
          response.hints.stale = `staging is ${h}h old — consider re-deploying staging with fresh changes`;
        }
      }

      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false, action,
        error: `Promote failed: ${message}`,
        hints: { fix: 'Check authentication and that staging has a deployment in gas-deploy.json' },
      };
    }
  }

  // --- action: deploy (default, always targets staging) ---

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
        success: false, action, environment: 'staging',
        error: `Pre-deploy push failed: ${pushResult.error}`,
        hints: { fix: 'Fix validation errors or check authentication, then retry deploy' },
      };
    }
  } catch (error: unknown) {
    // If localDir doesn't exist, continue — deploy works from remote state
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pre-deploy push skipped: ${message}`);
  }

  // Deploy lifecycle (post-push): create version snapshot → write circular buffer slot → update pointer
  // Invariant: gas-deploy.json written only after source pointer update succeeds; consumer failure is non-fatal
  try {
    // Create version snapshot
    const versionDesc = description ?? 'staging deploy by mcp-gas-deploy';
    const version = await deployOps.createVersion(scriptId, versionDesc);
    const N = version.versionNumber;

    // Set ISO_NOW once — reused for slot description + stagingDeployedAt
    const ISO_NOW = new Date().toISOString();

    const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);

    // Capture prod timestamp BEFORE write for staleness hint
    const prevProdDeployedAt = deployInfo.prodDeployedAt;

    // --- Find + write source slot ---
    const slotIndex = findNextSlotIndex(deployInfo.stagingSlotDescriptions);
    const slotIds = [...(deployInfo.stagingSlotIds ?? [])];

    if (slotIndex >= slotIds.length) {
      // New slot — create a new deployment for this slot
      const newSlot = await deployOps.createDeployment(scriptId, N, ISO_NOW);
      slotIds.push(newSlot.deploymentId);
    } else {
      // Existing slot — update it
      await deployOps.updateDeployment(scriptId, slotIds[slotIndex], N, ISO_NOW);
    }

    const updatedSlotVersions = [...(deployInfo.stagingSlotVersions ?? [])];
    updatedSlotVersions[slotIndex] = N;
    const updatedSlotDescriptions = [...(deployInfo.stagingSlotDescriptions ?? [])];
    updatedSlotDescriptions[slotIndex] = ISO_NOW;

    // --- Update pointer ("version 5") — always points to latest deployed version; no description ---
    let deploymentId: string;
    let webAppUrl: string | undefined;

    const existingStagingDeploymentId = deployInfo.stagingDeploymentId;
    if (existingStagingDeploymentId) {
      const updated = await deployOps.updateDeployment(scriptId, existingStagingDeploymentId, N);
      deploymentId = updated.deploymentId;
      webAppUrl = updated.webAppUrl;
    } else {
      // No pointer yet — find a web app deployment to reuse, or create a new one
      const deployments = await deployOps.listDeployments(scriptId);
      const webAppDeployment = deployments.find(d =>
        d.entryPoints?.some(ep => ep.entryPointType === 'WEB_APP')
      );

      if (webAppDeployment) {
        const updated = await deployOps.updateDeployment(scriptId, webAppDeployment.deploymentId, N);
        deploymentId = updated.deploymentId;
        webAppUrl = updated.webAppUrl;
      } else {
        const created = await deployOps.createDeployment(scriptId, N, 'staging-pointer');
        deploymentId = created.deploymentId;
        webAppUrl = created.webAppUrl;
      }
    }

    // Build updateInfo — gas-deploy.json written AFTER pointer update succeeds
    const updateInfo: Partial<DeploymentInfo> = {
      lastDeploy: ISO_NOW,
      stagingDeploymentId: deploymentId,
      stagingVersionNumber: N,
      stagingDeployedAt: ISO_NOW,
      stagingSlotIds: slotIds,
      stagingSlotVersions: updatedSlotVersions,
      stagingSlotDescriptions: updatedSlotDescriptions,
      stagingActiveSlotIndex: slotIndex,
    };
    if (webAppUrl) updateInfo.stagingUrl = webAppUrl;

    // Staleness hint: prod stale vs staging
    const hints: Record<string, string> = {
      next: webAppUrl
        ? `Deployed to staging (v${N}). URL: ${webAppUrl}. Run \`exec\` to verify.`
        : `Version ${N} deployed to staging. Deployment ID: ${deploymentId}.`,
    };

    const nowMs = Date.now();
    if (prevProdDeployedAt) {
      const prodAge = nowMs - new Date(prevProdDeployedAt).getTime();
      const stagingAge = nowMs - new Date(ISO_NOW).getTime();
      if (!isNaN(prodAge) && !isNaN(stagingAge)
          && stagingAge < prodAge && prodAge > STALE_THRESHOLD_MS) {
        const h = Math.round(prodAge / (60 * 60 * 1000));
        hints.stale = `prod is ${h}h behind staging (v${N}) — consider: action=promote`;
      }
    }

    const response: DeployToolResult = {
      success: true,
      action: 'deploy',
      environment: 'staging',
      versionNumber: N,
      deploymentId,
      webAppUrl,
      hints,
    };

    // --- Consumer update — non-fatal: consumer failure must not fail the source deploy ---
    const consumerScriptId = deployInfo.stagingConsumerScriptId;
    const userSymbol = deployInfo.userSymbol;
    const updatedSlotConsumerVersions = [...(deployInfo.stagingSlotConsumerVersions ?? [])];

    if (consumerScriptId && !userSymbol) {
      hints.consumerSkipped = 'Consumer shim skipped — userSymbol is not set in gas-deploy.json';
    } else if (userSymbol && !consumerScriptId) {
      hints.consumerSkipped = 'Consumer shim skipped — stagingConsumerScriptId is not set in gas-deploy.json';
    } else if (consumerScriptId && userSymbol) {
      try {
        validateUserSymbol(userSymbol);
        const consumerDeploymentId = deployInfo.stagingConsumerDeploymentId;
        const consumerResult = await updateConsumerShim(
          scriptId, consumerScriptId, consumerDeploymentId,
          description ?? 'Deploy to staging',
          fileOps, deployOps, userSymbol, N
        );
        updatedSlotConsumerVersions[slotIndex] = consumerResult.versionNumber;
        response.consumerUpdate = {
          scriptId: consumerScriptId,
          versionNumber: consumerResult.versionNumber,
          deploymentUpdated: consumerResult.deploymentUpdated,
        };
      } catch (consumerError: unknown) {
        // non-fatal: consumer failure must not fail the source deploy
        const msg = consumerError instanceof Error ? consumerError.message : String(consumerError);
        updatedSlotConsumerVersions[slotIndex] = null;
        response.consumerUpdate = { scriptId: consumerScriptId, error: `non-fatal: ${msg}` };
      }
    } else {
      updatedSlotConsumerVersions[slotIndex] = null;
    }

    updateInfo.stagingSlotConsumerVersions = updatedSlotConsumerVersions;

    // Write gas-deploy.json — only reached after pointer update succeeds
    await setDeploymentInfo(resolvedDir, scriptId, updateInfo);

    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, action, environment: 'staging',
      error: `Deploy failed: ${message}`,
      hints: { fix: 'Check authentication and project permissions. If deploy failed after version creation, re-run deploy to re-pin.' },
    };
  }
}
