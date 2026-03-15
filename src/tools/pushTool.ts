/**
 * Push Tool for mcp-gas-deploy
 *
 * Validates CommonJS structure → pushes ALL local files to GAS.
 * This is the CORE tool — local-first deployment.
 *
 * Files must follow the CommonJS pattern:
 *   function _main() { ... }
 *   __defineModule__(_main, false); // false=lazy, true=eager(triggers)
 *
 * Validation errors are returned with exact fix suggestions.
 */

import { GASFileOperations } from '../api/gasFileOperations.js';
import { push } from '../sync/rsync.js';
import type { PushPreviewResult } from '../sync/rsync.js';
import { resolveProject } from '../utils/resolveProject.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

export interface PushToolParams {
  scriptId?: string;
  localDir?: string;
  dryRun?: boolean;
  skipValidation?: boolean;
  prune?: boolean;
  action?: 'push' | 'preview';
  reparent?: boolean;
}

export interface PushToolResult {
  success: boolean;
  filesPushed: string[];
  validationErrors?: Array<{
    file: string;
    errors: Array<{
      rule: string;
      line?: number;
      message: string;
      suggestion: string;
    }>;
  }>;
  error?: string;
  hints: Record<string, string>;
  preview?: PushPreviewResult & { prune: boolean };
}

export const PUSH_TOOL_DEFINITION = {
  name: 'push',
  description: '[SYNC:PUSH] Push local .gs files to GAS with CommonJS validation. WHEN: uploading local changes. AVOID: use push({action: "preview"}) to see diff first. Example: push({scriptId: "1abc...", action: "preview"})',
  annotations: {
    title: 'Push Files to GAS',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      ...SchemaFragments.localDir,
      ...SchemaFragments.dryRun,
      skipValidation: {
        type: 'boolean',
        description: 'ONLY for system shim files (require.gs, __mcp_exec.gs) — never use for regular modules',
      },
      prune: {
        type: 'boolean',
        description: 'Remove remote-only files from GAS (files on remote not present locally). Default false (safe: preserves remote-only files). Pass true to explicitly delete ghost files.',
      },
      action: {
        type: 'string',
        enum: ['push', 'preview'],
        description: "'push' (default): validate and push files. 'preview': show structured diff without pushing.",
      },
      ...SchemaFragments.reparent,
    },
    required: [],
    additionalProperties: false,
    llmGuidance: {
      commonJs: GuidanceFragments.commonJsPattern,
      resolution: GuidanceFragments.claspResolution,
      preview: 'Use action="preview" to see a structured diff (toAdd, toUpdate, toPreserve, toPrune) before pushing.',
      skipValidation: 'ONLY for system shim files (require.gs, __mcp_exec.gs). Never for user modules — validation catches real bugs.',
      prune: 'Default false (safe). Set true to remove remote-only files. Git archive preserves deleted files for recovery.',
      triggers: GuidanceFragments.triggerSetup,
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      filesPushed: { type: 'array', items: { type: 'string' } },
      validationErrors: { type: 'array' },
      preview: { type: 'object' },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success', 'filesPushed'],
  },
};

async function handlePreviewAction(
  scriptId: string,
  params: PushToolParams,
  fileOps: GASFileOperations,
  resolvedDir: string
): Promise<PushToolResult> {
  const { skipValidation, prune } = params;
  const result = await push(scriptId, resolvedDir, fileOps, { dryRun: true, skipValidation, prune });

  if (!result.preview || result.mergeSkipped) {
    return {
      success: false,
      filesPushed: [],
      error: 'Preview unavailable — remote fetch failed',
      hints: { fix: 'Check authentication and that the project exists, then retry.' },
    };
  }

  const { toAdd, toUpdate, toPreserve, toPrune, totalFilesAfterPush } = result.preview;
  const parts: string[] = [];
  if (toAdd.length > 0) parts.push(`${toAdd.length} add`);
  if (toUpdate.length > 0) parts.push(`${toUpdate.length} update`);
  if (toPreserve.length > 0) parts.push(`${toPreserve.length} preserve`);
  if (toPrune.length > 0) parts.push(`${toPrune.length} prune`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes';

  return {
    success: true,
    filesPushed: [],
    preview: { toAdd, toUpdate, toPreserve, toPrune, totalFilesAfterPush, prune: prune ?? false },
    hints: {
      next: `preview: ${summary}. Run push to apply changes.`,
    },
  };
}

export async function handlePushTool(
  params: PushToolParams,
  fileOps: GASFileOperations
): Promise<PushToolResult> {
  const { dryRun, skipValidation, prune } = params;

  let resolved;
  try {
    resolved = await resolveProject({ scriptId: params.scriptId, localDir: params.localDir });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      filesPushed: [],
      error: message,
      hints: { fix: 'Provide scriptId explicitly, or point localDir to a directory with .clasp.json.' },
    };
  }

  const { scriptId, localDir: resolvedDir } = resolved;

  const action = params.action ?? 'push';
  if (action === 'preview') {
    return handlePreviewAction(scriptId, params, fileOps, resolvedDir);
  }

  const result = await push(scriptId, resolvedDir, fileOps, { dryRun, skipValidation, prune, reparent: params.reparent });

  if (!result.success) {
    if (result.validationErrors && result.validationErrors.length > 0) {
      return {
        success: false,
        filesPushed: [],
        validationErrors: result.validationErrors.map(r => ({
          file: r.file,
          errors: r.errors,
        })),
        error: result.error,
        hints: {
          fix: 'Fix the validation errors above, then re-run push',
          commonjs: 'GAS CommonJS: function _main(){ exports.fn=function(){...}; } __defineModule__(_main,false);',
          triggers: 'Trigger files (doGet, onOpen) need `__events__.X = ...` inside _main() and `__defineModule__(_main, true)`',
        },
      };
    }

    return {
      success: false,
      filesPushed: [],
      error: result.error,
      hints: { fix: `Push failed for scriptId=${scriptId}: ${result.error}. Check authentication and that the project exists.` },
    };
  }

  if (result.filesPushed.length === 0) {
    return {
      success: true,
      filesPushed: [],
      hints: {
        next: 'All files are already in sync. No push needed.',
      },
    };
  }

  const verb = dryRun ? 'would be pushed' : 'pushed';
  const hints: Record<string, string> = {
    next: dryRun
      ? `${result.filesPushed.length} files ${verb}. Run without dryRun to push.`
      : `${result.filesPushed.length} files ${verb}. Run \`exec\` to verify or \`deploy\` to create a stable version.${prune ? ' Remote-only files were pruned.' : ''}`,
  };
  if (result.mergeSkipped) {
    hints.warning = 'Remote files could not be fetched for merge — remote-only files may have been removed';
  }
  if (result.gitArchived && result.archivedFiles?.length) {
    hints.gitArchive = `${result.archivedFiles.length} remote-only file(s) archived in git. Use \`git log --diff-filter=A -- <filename>\` to find archived files.`;
  }
  return {
    success: true,
    filesPushed: result.filesPushed,
    hints,
  };
}
