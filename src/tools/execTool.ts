/**
 * Exec Tool for mcp-gas-deploy
 *
 * Executes a GAS function via the web app deployment URL.
 * Auto-pushes if local is ahead of remote (status → push → exec chain).
 *
 * Pre-exec guard: if no web app URL in gas-deploy.json, returns actionable error.
 * Divergence guard: if BOTH localAhead AND remoteAhead, halts with "pull first" error.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { getStatus } from '../sync/rsync.js';
import { push } from '../sync/rsync.js';
import { getDeploymentInfo } from '../config/deployConfig.js';
import { SessionManager } from '../auth/sessionManager.js';

const SCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const FUNCTION_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface ExecToolParams {
  scriptId: string;
  localDir?: string;
  function: string;
  args?: unknown[];
}

export interface ExecToolResult {
  success: boolean;
  result?: unknown;
  logs?: string;
  syncedBeforeExec: boolean;
  filesSync?: number;
  error?: string;
  hints: Record<string, string>;
}

export const EXEC_TOOL_DEFINITION = {
  name: 'exec',
  description: `Execute a GAS function via web app deployment URL. Auto-pushes if local is ahead of remote.

Requires a web app deployment — run \`deploy\` first if none exists.
If local files are ahead, validates and pushes them before executing.`,
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
      function: {
        type: 'string',
        description: 'Function name to execute',
      },
      args: {
        type: 'array',
        description: 'Arguments to pass to the function',
        items: {},
      },
    },
    required: ['scriptId', 'function'],
  },
};

export async function handleExecTool(
  params: ExecToolParams,
  fileOps: GASFileOperations,
  sessionManager: SessionManager
): Promise<ExecToolResult> {
  const { scriptId, localDir, args } = params;
  const functionName = params.function;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false, syncedBeforeExec: false,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  if (!FUNCTION_PATTERN.test(functionName)) {
    return {
      success: false, syncedBeforeExec: false,
      error: 'Invalid function name',
      hints: { fix: 'Function name must be a valid JavaScript identifier' },
    };
  }

  const resolvedDir = localDir
    ? path.resolve(localDir)
    : path.join(os.homedir(), 'gas-projects', scriptId);

  if (localDir && !resolvedDir.startsWith(os.homedir())) {
    return {
      success: false, syncedBeforeExec: false,
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
    };
  }

  // Pre-exec guard: check if localDir exists
  try {
    await fs.access(resolvedDir);
  } catch {
    return {
      success: false, syncedBeforeExec: false,
      error: `Local directory not found: ${resolvedDir}`,
      hints: { fix: 'Run `pull` first to fetch the project files' },
    };
  }

  // Check for web app deployment URL
  const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
  const execUrl = deployInfo.stagingUrl ?? deployInfo.prodUrl;

  if (!execUrl) {
    return {
      success: false, syncedBeforeExec: false,
      error: 'No deployment URL found',
      hints: { fix: 'Run `deploy` first to create a web app deployment, then retry `exec`' },
    };
  }

  // Pre-exec: check sync status
  let syncedBeforeExec = false;
  let filesSync = 0;

  try {
    const status = await getStatus(scriptId, resolvedDir, fileOps);

    // Divergence guard: both local and remote have changes
    if (status.localAhead.length > 0 && status.remoteAhead.length > 0) {
      return {
        success: false, syncedBeforeExec: false,
        error: 'Remote has changes not in your local copy — run `pull` first to merge, then retry',
        hints: {
          fix: 'Your local and remote have diverged. Pull remote changes first.',
          commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
        },
      };
    }

    // Auto-push if local is ahead
    if (status.localAhead.length > 0 || status.localOnly.length > 0) {
      const pushResult = await push(scriptId, resolvedDir, fileOps);

      if (!pushResult.success) {
        return {
          success: false, syncedBeforeExec: false,
          error: `Auto-push failed: ${pushResult.error}`,
          validationErrors: pushResult.validationErrors,
          hints: {
            fix: pushResult.validationErrors
              ? 'Fix the validation errors, then retry exec'
              : 'Check authentication and network, then retry',
            commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
          },
        } as ExecToolResult & { validationErrors?: unknown };
      }

      syncedBeforeExec = true;
      filesSync = pushResult.filesPushed.length;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, syncedBeforeExec: false,
      error: `Sync check failed: ${message}`,
      hints: { fix: 'Check authentication and try again' },
    };
  }

  // Execute via web app URL
  try {
    const token = await sessionManager.getValidToken();
    if (!token) {
      return {
        success: false, syncedBeforeExec,
        error: 'Not authenticated',
        hints: { fix: 'Run auth with action="login"' },
      };
    }

    const body = {
      function: functionName,
      parameters: args ?? [],
    };

    const response = await fetch(execUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false, syncedBeforeExec, filesSync,
        error: `Execution failed (HTTP ${response.status}): ${text}`,
        hints: { fix: 'Check the function name and deployment configuration' },
      };
    }

    const data = await response.json() as { result?: unknown; logs?: string };

    return {
      success: true,
      result: data.result ?? data,
      logs: data.logs,
      syncedBeforeExec,
      filesSync,
      hints: {
        next: syncedBeforeExec
          ? `Function executed. ${filesSync} files synced before execution. Local and remote are in sync.`
          : 'Function executed. Local and remote are in sync.',
        commonjs: 'Remember: all code inside `function _main()`, call `__defineModule__(_main, false)` at end',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, syncedBeforeExec, filesSync,
      error: `Execution failed: ${message}`,
      hints: { fix: 'Check the deployment URL and function name' },
    };
  }
}
