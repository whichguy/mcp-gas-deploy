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

import path from 'node:path';
import os from 'node:os';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { push } from '../sync/rsync.js';
import type { PushPreviewResult } from '../sync/rsync.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';

export interface PushToolParams {
  scriptId: string;
  localDir?: string;
  dryRun?: boolean;
  skipValidation?: boolean;
  prune?: boolean;
  action?: 'push' | 'preview';
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
  description: `Push local .gs files to GAS after CommonJS validation.

ALL .gs files MUST follow the CommonJS module pattern:
  function _main() { exports.fn = function() { ... }; }
  __defineModule__(_main, false); // false=lazy | true=eager (trigger files)
Trigger files: assign __events__.onOpen = ... inside _main() — no bare trigger functions.

Validation errors include line numbers and fix suggestions.
skipValidation=true: ONLY for system shim files (require.gs, __mcp_exec.gs).`,
  annotations: { destructiveHint: true },
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
      dryRun: {
        type: 'boolean',
        description: 'Preview which files would be pushed without actually pushing',
      },
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
    },
    required: ['scriptId'],
  },
};

async function handlePreviewAction(
  params: PushToolParams,
  fileOps: GASFileOperations,
  resolvedDir: string
): Promise<PushToolResult> {
  const { scriptId, skipValidation, prune } = params;
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
  const { scriptId, localDir, dryRun, skipValidation, prune } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      filesPushed: [],
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
      filesPushed: [],
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
    };
  }

  const action = params.action ?? 'push';
  if (action === 'preview') {
    return handlePreviewAction(params, fileOps, resolvedDir);
  }

  const result = await push(scriptId, resolvedDir, fileOps, { dryRun, skipValidation, prune });

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
