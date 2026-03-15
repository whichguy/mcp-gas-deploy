/**
 * Pull Tool for mcp-gas-deploy
 *
 * Fetches all GAS files to a local directory. Auto-initializes git.
 */

import path from 'node:path';
import os from 'node:os';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { pull } from '../sync/rsync.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

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
  description: '[SYNC:PULL] Fetch GAS project files to local directory — auto-initializes git. WHEN: first setup or syncing remote changes. AVOID: use status to check sync state first. Example: pull({scriptId: "1abc...", dryRun: true})',
  annotations: {
    title: 'Pull Files from GAS',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      targetDir: {
        type: 'string',
        description: 'Local directory to write files to (default: ~/gas-projects/<scriptId>)',
      },
      ...SchemaFragments.dryRun,
    },
    required: ['scriptId'],
    additionalProperties: false,
    llmGuidance: {
      commonJs: GuidanceFragments.commonJsPattern,
      dryRun: 'Use dryRun: true to preview which files will be written without modifying the filesystem.',
      gitInit: 'Pull auto-initializes a git repo in the target directory for version tracking.',
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      filesPulled: { type: 'array', items: { type: 'string' } },
      localDir: { type: 'string' },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success', 'filesPulled', 'localDir'],
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
  if (targetDir && !resolvedDir.startsWith(os.homedir() + path.sep)) {
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
