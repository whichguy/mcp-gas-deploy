/**
 * Status Tool for mcp-gas-deploy
 *
 * Compares local files vs remote GAS using Git SHA-1 hashes.
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
  description: `Compare local .gs files vs remote GAS project using Git SHA-1 hashes.

Shows which files are in sync, ahead locally, or changed remotely.
Local-ahead files will be CommonJS-validated on next push:
  function _main() { exports.myFn = ...; }  __defineModule__(_main, false);`,
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

  if (localDir && !resolvedDir.startsWith(os.homedir())) {
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
    if (status.inSync.length > 0) parts.push(`${status.inSync.length} in sync`);
    if (status.localAhead.length > 0) parts.push(`${status.localAhead.length} local ahead`);
    if (status.remoteAhead.length > 0) parts.push(`${status.remoteAhead.length} remote ahead`);
    if (status.localOnly.length > 0) parts.push(`${status.localOnly.length} local only`);
    if (status.remoteOnly.length > 0) parts.push(`${status.remoteOnly.length} remote only`);

    const summary = parts.length > 0 ? parts.join(', ') : 'No files found';

    const hints: Record<string, string> = {
      commonjs: 'GAS CommonJS: function _main(){ exports.fn=function(){...}; } __defineModule__(_main,false);',
    };

    if (status.localAhead.length > 0) {
      hints.next = 'Run `push` to deploy local changes, or `exec` to test (auto-pushes)';
    } else if (status.remoteAhead.length > 0) {
      hints.next = 'Run `pull` to fetch remote changes';
    } else {
      hints.next = 'Local and remote are in sync. Edit files locally and run `push` when ready.';
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
