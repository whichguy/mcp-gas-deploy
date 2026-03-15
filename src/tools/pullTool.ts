/**
 * Pull Tool for mcp-gas-deploy
 *
 * Fetches all GAS files to a local directory. Directory must already exist
 * (use `create` tool to bootstrap new projects).
 */

import { GASFileOperations } from '../api/gasFileOperations.js';
import { pull } from '../sync/rsync.js';
import { resolveProject } from '../utils/resolveProject.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

export interface PullToolParams {
  scriptId?: string;
  localDir?: string;
  /** @deprecated Use localDir instead. Accepted as alias for backward compatibility. */
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
  description: '[SYNC:PULL] Fetch GAS project files to existing local directory. WHEN: syncing remote changes. PREREQ: directory must exist (use create tool for new projects). AVOID: use status to check sync state first. Example: pull({scriptId: "1abc...", dryRun: true})',
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
        description: 'Local directory to write files to (default: CWD). Must already exist. If it contains .clasp.json, scriptId is read from it.',
      },
      targetDir: {
        type: 'string',
        description: 'Deprecated — use localDir instead. Accepted as alias for backward compatibility.',
      },
      ...SchemaFragments.dryRun,
    },
    required: [],
    additionalProperties: false,
    llmGuidance: {
      commonJs: GuidanceFragments.commonJsPattern,
      resolution: GuidanceFragments.claspResolution,
      dryRun: 'Use dryRun: true to preview which files will be written without modifying the filesystem.',
      gitInit: 'Git init is handled by the create tool. Pull only writes files to an existing directory.',
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
  const { dryRun } = params;
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
      hints: { fix: 'Check that the scriptId is valid, you have access, and the directory exists (use create tool for new projects).' },
    };
  }

  const hints: Record<string, string> = {
    next: 'Edit files locally, then run `push` to deploy or `exec` to test',
    commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
    triggers: 'For trigger files: use `__events__.onOpen = ...` inside _main() and loadNow: true',
  };
  if (resolved.resolvedFrom === 'clasp-json') {
    hints.scriptId = `Using scriptId ${scriptId} from .clasp.json`;
  }

  return {
    success: true,
    filesPulled: result.filesPulled,
    localDir: resolvedDir,
    hints,
  };
}
