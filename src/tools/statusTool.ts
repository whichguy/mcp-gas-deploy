/**
 * Status Tool for mcp-gas-deploy
 *
 * Compares local files vs remote GAS by file name AND content hash.
 * Shows which files are local-only, remote-only, in-sync, or modified.
 */

import { GASFileOperations } from '../api/gasFileOperations.js';
import { getStatus, type SyncStatus } from '../sync/rsync.js';
import { getDeploymentInfo, type DeploymentInfo, STALE_THRESHOLD_MS } from '../config/deployConfig.js';
import { resolveProject } from '../utils/resolveProject.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

function buildStalenessHints(
  info: DeploymentInfo | undefined,
  hasLocalChanges: boolean
): Record<string, string> {
  const hints: Record<string, string> = {};
  if (!info) return hints;

  const now = Date.now();
  const stagingAge = info.stagingDeployedAt
    ? now - new Date(info.stagingDeployedAt).getTime() : null;
  const prodAge = info.prodDeployedAt
    ? now - new Date(info.prodDeployedAt).getTime() : null;

  // prod stale vs staging — suppress if already on the same version
  if (stagingAge !== null && prodAge !== null
      && stagingAge < prodAge && prodAge > STALE_THRESHOLD_MS
      && (info.stagingVersionNumber == null || info.prodVersionNumber == null
          || info.stagingVersionNumber !== info.prodVersionNumber)) {
    const h = Math.round(prodAge / (60 * 60 * 1000));
    hints.staleprod = `prod is ${h}h behind staging (v${info.stagingVersionNumber ?? '?'}) — consider: action=promote`;
  }

  // local changes + staging stale
  if (hasLocalChanges && stagingAge !== null && stagingAge > STALE_THRESHOLD_MS) {
    const h = Math.round(stagingAge / (60 * 60 * 1000));
    hints.staledev = `${h}h since last staging deploy with local changes pending — consider: push then action=deploy`;
  }

  return hints;
}

export interface StatusToolParams {
  scriptId?: string;
  localDir?: string;
}

export interface DeploymentSlot {
  slotIndex: number;           // 0-based (slot 1 = index 0)
  deploymentId: string;
  url: string;                 // web app URL — constructed from deploymentId (/exec suffix)
  versionNumber: number;
  deployedAt: string;          // ISO timestamp from slot description field
  isActive: boolean;           // true when pointer currently serves this slot's version
  consumerVersionNumber?: number | null;
  note: string;                // e.g. "active" or "rollback available"
}

export interface DeploymentUrls {
  /** HEAD deployment — always points to the latest push; suffix /dev; used by exec */
  head?: { url?: string; deploymentId?: string; note: string };
  /** Staging deployment — pinned to a specific version; suffix /exec; use for testing */
  staging?: { url?: string; deploymentId?: string; versionNumber?: number; note: string };
  /** Prod deployment — pinned to a specific version; suffix /exec; live traffic */
  prod?: { url?: string; deploymentId?: string; versionNumber?: number; note: string };
  /** Circular buffer slots for staging (omitted when stagingSlotIds is absent or empty) */
  stagingSlots?: DeploymentSlot[];
  /** Circular buffer slots for prod (omitted when prodSlotIds is absent or empty) */
  prodSlots?: DeploymentSlot[];
}

export interface StatusToolResult {
  success: boolean;
  status?: SyncStatus;
  summary: string;
  error?: string;
  hints: Record<string, string>;
  /** Known deployment URLs from gas-deploy.json — absent if gas-deploy.json does not exist */
  deployments?: DeploymentUrls;
}

export const STATUS_TOOL_DEFINITION = {
  name: 'status',
  description: '[SYNC:STATUS] Compare local vs remote files and show deployment URLs. WHEN: before push/deploy, checking deployment health, finding URLs. AVOID: use ls for file metadata without sync comparison. Example: status({scriptId: "1abc..."})',
  annotations: {
    title: 'Sync & Deploy Status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      ...SchemaFragments.localDir,
    },
    required: [],
    additionalProperties: false,
    llmGuidance: {
      deploymentUrls: 'Response includes head (dev), staging, and prod URLs when gas-deploy.json exists. Use these URLs for browser testing.',
      staleness: 'Staleness hints appear when prod is behind staging or local changes are pending. Follow the suggested action.',
      resolution: GuidanceFragments.claspResolution,
      circularBuffer: GuidanceFragments.circularBuffer,
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      status: { type: 'object' },
      summary: { type: 'string' },
      deployments: {
        type: 'object',
        properties: {
          head: { type: 'object' },
          staging: { type: 'object' },
          prod: { type: 'object' },
          stagingSlots: { type: 'array' },
          prodSlots: { type: 'array' },
        },
      },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success', 'summary'],
  },
};

export async function handleStatusTool(
  params: StatusToolParams,
  fileOps: GASFileOperations
): Promise<StatusToolResult> {
  let resolved;
  try {
    resolved = await resolveProject({ scriptId: params.scriptId, localDir: params.localDir });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: '',
      error: message,
      hints: { fix: 'Provide scriptId explicitly, or point localDir to a directory with .clasp.json.' },
    };
  }

  const { scriptId, localDir: resolvedDir } = resolved;

  try {
    const status = await getStatus(scriptId, resolvedDir, fileOps);

    const parts: string[] = [];
    if (status.both.length > 0) parts.push(`${status.both.length} in sync`);
    if (status.modified.length > 0) parts.push(`${status.modified.length} modified: ${status.modified.map(f => f.name).join(', ')}`);
    if (status.localOnly.length > 0) parts.push(`${status.localOnly.length} local only: ${status.localOnly.map(f => f.name).join(', ')}`);
    if (status.remoteOnly.length > 0) parts.push(`${status.remoteOnly.length} remote only: ${status.remoteOnly.map(f => f.name).join(', ')}`);

    const summary = parts.length > 0 ? parts.join(' | ') : 'No files found';

    const hints: Record<string, string> = {};

    if (resolved.resolvedFrom === 'clasp-json') {
      hints.scriptId = `Using scriptId ${scriptId} from .clasp.json`;
    }

    if (status.localOnly.length > 0 || status.modified.length > 0) {
      hints.next = 'local changes detected — push or exec to sync';
    } else if (status.remoteOnly.length > 0) {
      hints.next = 'remote-only files — pull to fetch';
    } else {
      hints.next = 'in sync';
    }

    // Merge staleness hints and deployment URLs (non-fatal — missing gas-deploy.json is not an error)
    let deployments: DeploymentUrls | undefined;
    try {
      const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
      const hasLocalChanges = status.modified.length > 0 || status.localOnly.length > 0;
      Object.assign(hints, buildStalenessHints(deployInfo, hasLocalChanges));

      // Build deployment URL map — only include tiers that have been configured
      const urls: DeploymentUrls = {};
      if (deployInfo.headUrl || deployInfo.headDeploymentId) {
        urls.head = {
          url: deployInfo.headUrl,
          deploymentId: deployInfo.headDeploymentId,
          note: 'HEAD (/dev) — always latest push; used by exec',
        };
      }
      if (deployInfo.stagingUrl || deployInfo.stagingDeploymentId) {
        urls.staging = {
          url: deployInfo.stagingUrl,
          deploymentId: deployInfo.stagingDeploymentId,
          versionNumber: deployInfo.stagingVersionNumber,
          note: `versioned (/exec) — v${deployInfo.stagingVersionNumber ?? '?'}; use this URL for testing`,
        };
      }
      if (deployInfo.prodUrl || deployInfo.prodDeploymentId) {
        urls.prod = {
          url: deployInfo.prodUrl,
          deploymentId: deployInfo.prodDeploymentId,
          versionNumber: deployInfo.prodVersionNumber,
          note: `versioned (/exec) — v${deployInfo.prodVersionNumber ?? '?'}; live traffic`,
        };
      }
      // Surface circular buffer slot state — omit entirely when slotIds absent or empty
      if (deployInfo.stagingSlotIds && deployInfo.stagingSlotIds.length > 0) {
        const slotIds = deployInfo.stagingSlotIds;
        const slotVersions = deployInfo.stagingSlotVersions ?? [];
        const slotDescriptions = deployInfo.stagingSlotDescriptions ?? [];
        const slotConsumerVersions = deployInfo.stagingSlotConsumerVersions ?? [];
        const activeIndex = deployInfo.stagingActiveSlotIndex ?? 0;

        urls.stagingSlots = slotIds.map((id, i): DeploymentSlot => ({
          slotIndex: i,
          deploymentId: id,
          url: `https://script.google.com/macros/s/${id}/exec`,
          versionNumber: slotVersions[i] ?? 0,
          deployedAt: slotDescriptions[i] ?? '',
          isActive: i === activeIndex,
          consumerVersionNumber: slotConsumerVersions[i] ?? null,
          note: i === activeIndex ? 'active' : 'rollback available',
        }));
      }

      if (deployInfo.prodSlotIds && deployInfo.prodSlotIds.length > 0) {
        const slotIds = deployInfo.prodSlotIds;
        const slotVersions = deployInfo.prodSlotVersions ?? [];
        const slotDescriptions = deployInfo.prodSlotDescriptions ?? [];
        const slotConsumerVersions = deployInfo.prodSlotConsumerVersions ?? [];
        const activeIndex = deployInfo.prodActiveSlotIndex ?? 0;

        urls.prodSlots = slotIds.map((id, i): DeploymentSlot => ({
          slotIndex: i,
          deploymentId: id,
          url: `https://script.google.com/macros/s/${id}/exec`,
          versionNumber: slotVersions[i] ?? 0,
          deployedAt: slotDescriptions[i] ?? '',
          isActive: i === activeIndex,
          consumerVersionNumber: slotConsumerVersions[i] ?? null,
          note: i === activeIndex ? 'active' : 'rollback available',
        }));
      }

      if (urls.head || urls.staging || urls.prod || urls.stagingSlots || urls.prodSlots) deployments = urls;
    } catch {
      // Suppress — deployment info is optional; missing config is not a status error
    }

    return { success: true, status, summary, hints, deployments };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: '',
      error: message,
      hints: { fix: 'Check that the scriptId is valid and you are authenticated' },
    };
  }
}
