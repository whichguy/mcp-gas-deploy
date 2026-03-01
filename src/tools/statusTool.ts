/**
 * Status Tool for mcp-gas-deploy
 *
 * Compares local files vs remote GAS by file name AND content hash.
 * Shows which files are local-only, remote-only, in-sync, or modified.
 */

import path from 'node:path';
import os from 'node:os';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { getStatus, type SyncStatus } from '../sync/rsync.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';

export interface StatusToolParams {
  scriptId: string;
  localDir?: string;
}

export interface StatusToolResult {
  success: boolean;
  status?: SyncStatus;
  summary: string;
  error?: string;
  hints: Record<string, string>;
}

export const STATUS_TOOL_DEFINITION = {
  name: 'status',
  description: `Read-only: compare local .gs files vs remote GAS project by name and content hash. Shows inSync, modified, localOnly, remoteOnly counts. push and exec always push all local files.`,
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'Google Apps Script project ID',
      },
      localDir: {
        type: 'string',
        description: 'Local directory to compare (default: ~/gas-projects/<scriptId>)',
      },
    },
    required: ['scriptId'],
  },
};

export async function handleStatusTool(
  params: StatusToolParams,
  fileOps: GASFileOperations
): Promise<StatusToolResult> {
  const { scriptId, localDir } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      summary: '',
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  const resolvedDir = localDir
    ? path.resolve(localDir)
    : path.join(os.homedir(), 'gas-projects', scriptId);

  if (localDir && !resolvedDir.startsWith(os.homedir() + path.sep)) {
    return {
      success: false,
      summary: '',
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
    };
  }

  try {
    const status = await getStatus(scriptId, resolvedDir, fileOps);

    const parts: string[] = [];
    if (status.both.length > 0) parts.push(`${status.both.length} in sync`);
    if (status.modified.length > 0) parts.push(`${status.modified.length} modified: ${status.modified.map(f => f.name).join(', ')}`);
    if (status.localOnly.length > 0) parts.push(`${status.localOnly.length} local only: ${status.localOnly.map(f => f.name).join(', ')}`);
    if (status.remoteOnly.length > 0) parts.push(`${status.remoteOnly.length} remote only: ${status.remoteOnly.map(f => f.name).join(', ')}`);

    const summary = parts.length > 0 ? parts.join(' | ') : 'No files found';

    const hints: Record<string, string> = {};

    if (status.localOnly.length > 0 || status.modified.length > 0) {
      hints.next = 'local changes detected — push or exec to sync';
    } else if (status.remoteOnly.length > 0) {
      hints.next = 'remote-only files — pull to fetch';
    } else {
      hints.next = 'in sync';
    }

    return { success: true, status, summary, hints };
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
