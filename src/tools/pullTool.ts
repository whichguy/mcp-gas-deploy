/**
 * Pull Tool for mcp-gas-deploy
 *
 * Fetches all GAS files to a local directory. Auto-initializes git.
 * Writes .clasp.json after pull so the directory is self-describing.
 */

import { GASFileOperations } from '../api/gasFileOperations.js';
import { pull, ensureClaspFiles } from '../sync/rsync.js';
import { resolveProject } from '../utils/resolveProject.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

export interface PullToolParams {
  scriptId?: string;
  localDir?: string;
  /** @deprecated Use localDir instead. Accepted as alias for backward compatibility. */
  targetDir?: string;
  dryRun?: boolean;
  reparent?: boolean;
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
      localDir: {
        type: 'string',
        description: 'Local directory to write files to (default: ~/gas-projects/<scriptId>). If it contains .clasp.json, scriptId is read from it.',
      },
      targetDir: {
        type: 'string',
        description: 'Deprecated — use localDir instead. Accepted as alias for backward compatibility.',
      },
      ...SchemaFragments.dryRun,
      ...SchemaFragments.reparent,
    },
    required: [],
    additionalProperties: false,
    llmGuidance: {
      commonJs: GuidanceFragments.commonJsPattern,
      resolution: GuidanceFragments.claspResolution,
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
  const { dryRun, reparent } = params;
  // Accept targetDir as deprecated alias for localDir
  const localDir = params.localDir ?? params.targetDir;

  let resolved;
  try {
    resolved = await resolveProject({ scriptId: params.scriptId, localDir });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      filesPulled: [],
      localDir: '',
      error: message,
      hints: { fix: 'Provide scriptId explicitly, or point localDir to a directory with .clasp.json.' },
    };
  }

  const { scriptId, localDir: resolvedDir } = resolved;

  if (dryRun) {
    try {
      const remoteFiles = await fileOps.getProjectFiles(scriptId);
      return {
        success: true,
        filesPulled: remoteFiles.map(f => f.name),
        localDir: resolvedDir,
        hints: {
          next: `Run pull without dryRun to write ${remoteFiles.length} files to ${resolvedDir}`,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        filesPulled: [],
        localDir: resolvedDir,
        error: `Failed to list remote files: ${message}`,
        hints: { fix: 'Check authentication and that the scriptId is valid' },
      };
    }
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

  // Write .clasp.json so the directory is self-describing for future operations
  const claspResult = await ensureClaspFiles(resolvedDir, scriptId, reparent);

  const hints: Record<string, string> = {
    next: 'Edit files locally, then run `push` to deploy or `exec` to test',
    commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
    triggers: 'For trigger files: use `__events__.onOpen = ...` inside _main() and loadNow: true',
  };
  if (resolved.resolvedFrom === 'clasp-json') {
    hints.scriptId = `Using scriptId ${scriptId} from .clasp.json`;
  }
  if (claspResult.clasp === 'created') {
    hints.claspJson = `Created .clasp.json with scriptId ${scriptId}`;
  } else if (claspResult.clasp === 'updated') {
    hints.claspJson = `Updated .clasp.json scriptId to ${scriptId} (reparent)`;
  }
  if (claspResult.gitignoreUpdated) {
    hints.gitignore = 'Added .clasp.json to .gitignore';
  }

  return {
    success: true,
    filesPulled: result.filesPulled,
    localDir: resolvedDir,
    hints,
  };
}
