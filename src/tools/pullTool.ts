/**
 * Pull Tool for mcp-gas-deploy
 *
 * Fetches all GAS files to a local directory. Auto-initializes git.
 */

import path from 'node:path';
import os from 'node:os';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { pull } from '../sync/rsync.js';

// Input validation patterns
const SCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

export interface PullToolParams {
  scriptId: string;
  targetDir?: string;
  dryRun?: boolean;
}

export interface PullToolResult {
  success: boolean;
  filesPulled: string[];
  localDir: string;
  error?: string;
  hints: Record<string, string>;
}

export const PULL_TOOL_DEFINITION = {
  name: 'pull',
  description: `Fetch all files from a GAS project to a local directory. Auto-initializes git.

Files are written AS-IS from GAS — CommonJS module wrappers are preserved.
The LLM sees and edits the raw CommonJS pattern directly.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'Google Apps Script project ID',
      },
      targetDir: {
        type: 'string',
        description: 'Local directory to write files to (default: ~/gas-projects/<scriptId>)',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview files without writing',
      },
    },
    required: ['scriptId'],
  },
};

export async function handlePullTool(
  params: PullToolParams,
  fileOps: GASFileOperations
): Promise<PullToolResult> {
  const { scriptId, targetDir, dryRun } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      filesPulled: [],
      localDir: '',
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  // Resolve local directory — prevent path traversal
  const baseDir = path.join(os.homedir(), 'gas-projects');
  const resolvedDir = targetDir
    ? path.resolve(targetDir)
    : path.join(baseDir, scriptId);

  // Guard against path traversal via targetDir
  if (targetDir && !resolvedDir.startsWith(os.homedir())) {
    return {
      success: false,
      filesPulled: [],
      localDir: '',
      error: 'targetDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit targetDir' },
    };
  }

  if (dryRun) {
    const remoteFiles = await fileOps.getProjectFiles(scriptId);
    return {
      success: true,
      filesPulled: remoteFiles.map(f => f.name),
      localDir: resolvedDir,
      hints: {
        next: `Run pull without dryRun to write ${remoteFiles.length} files to ${resolvedDir}`,
        commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
      },
    };
  }

  const result = await pull(scriptId, resolvedDir, fileOps);

  if (!result.success) {
    return {
      success: false,
      filesPulled: [],
      localDir: resolvedDir,
      error: result.error,
      hints: { fix: 'Check that the scriptId is valid and you have access to the project' },
    };
  }

  return {
    success: true,
    filesPulled: result.filesPulled,
    localDir: resolvedDir,
    hints: {
      next: 'Edit files locally, then run `push` to deploy or `exec` to test',
      commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
      triggers: 'For trigger files: use `__events__.onOpen = ...` inside _main() and loadNow: true',
    },
  };
}
