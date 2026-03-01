/**
 * Exec Tool for mcp-gas-deploy
 *
 * Executes a GAS function via the web app deployment URL.
 * Auto-pushes all local files before execution.
 *
 * Pre-exec guard: if no web app URL in gas-deploy.json, returns actionable error.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { GASDeployOperations } from '../api/gasDeployOperations.js';
import { push } from '../sync/rsync.js';
import { getDeploymentInfo, setDeploymentInfo } from '../config/deployConfig.js';
import { SessionManager } from '../auth/sessionManager.js';
import { SCRIPT_ID_PATTERN, FUNCTION_PATTERN, MODULE_NAME_PATTERN } from '../utils/validation.js';
import type { ValidationResult } from '../validation/commonjsValidator.js';

export interface ExecToolParams {
  scriptId: string;
  localDir?: string;
  module?: string;
  function: string;
  args?: unknown[];
}

export interface ExecToolResult {
  success: boolean;
  result?: unknown;
  logs?: string;
  filesSync?: number;
  error?: string;
  validationErrors?: ValidationResult[];
  hints: Record<string, string>;
}

export const EXEC_TOOL_DEFINITION = {
  name: 'exec',
  description: `Execute a GAS function via web app deployment URL. Auto-pushes all local files before execution.

Requires a web app deployment — run \`deploy\` first if none exists.
The function MUST be exported inside _main(): exports.myFn = function() { ... }
Auto-push validates CommonJS structure before pushing.`,
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
      module: {
        type: 'string',
        description: 'CommonJS module name — if provided, calls require(module)[function](...args) directly. Omit to route through runner-api.',
      },
      function: {
        type: 'string',
        description: 'Function name to execute — must be exported inside _main(): exports.<function> = function() {...}',
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

/**
 * Convert a workspace-domain web app URL to the standard format that accepts Bearer tokens.
 *
 * Workspace URLs (https://script.google.com/a/macros/<domain>/s/<id>/exec) trigger
 * Google Workspace IAP, which rejects programmatic Bearer tokens.
 * Standard URLs (https://script.google.com/macros/s/<id>/exec) accept Bearer tokens.
 */
function normalizeWebAppUrl(url: string): string {
  return url.replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    'https://script.google.com/macros/s/'
  );
}

export async function handleExecTool(
  params: ExecToolParams,
  fileOps: GASFileOperations,
  sessionManager: SessionManager,
  deployOps: GASDeployOperations
): Promise<ExecToolResult> {
  const { scriptId, localDir, module: moduleName, args } = params;
  const functionName = params.function;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  if (!FUNCTION_PATTERN.test(functionName)) {
    return {
      success: false,
      error: 'Invalid function name',
      hints: { fix: 'Function name must be a valid JavaScript identifier' },
    };
  }

  // Validate moduleName to prevent JS injection via unescaped single quotes in the exec statement
  if (moduleName !== undefined && !MODULE_NAME_PATTERN.test(moduleName)) {
    return {
      success: false,
      error: 'Invalid module name',
      hints: { fix: 'Module name must be a valid identifier or path (e.g. "module" or "common-js/module"). No quotes or backticks.' },
    };
  }

  const resolvedDir = localDir
    ? path.resolve(localDir)
    : path.join(os.homedir(), 'gas-projects', scriptId);

  if (localDir && !resolvedDir.startsWith(os.homedir() + path.sep)) {
    return {
      success: false,
      error: 'localDir must resolve within your home directory',
      hints: { fix: 'Use an absolute path within your home directory or omit localDir' },
    };
  }

  // Pre-exec guard: check if localDir exists
  try {
    await fs.access(resolvedDir);
  } catch {
    return {
      success: false,
      error: `Local directory not found: ${resolvedDir}`,
      hints: { fix: 'Run `pull` first to fetch the project files' },
    };
  }

  // Check for any deployment URL (pre-exec guard — ensures deploy has been run)
  const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
  const anyUrl = deployInfo.headUrl ?? deployInfo.stagingUrl ?? deployInfo.prodUrl;

  if (!anyUrl) {
    return {
      success: false,
      error: 'No deployment URL found',
      hints: { fix: 'Run `deploy` first to create a web app deployment, then retry `exec`' },
    };
  }

  // Resolve the HEAD deployment URL (ends in /dev) — required for ?_mcp_run=true.
  // Versioned /exec URLs redirect back to /exec even with /dev appended; only a true
  // HEAD deployment returns a /dev URL that accepts dynamic execution.
  let headUrl = deployInfo.headUrl;
  if (!headUrl) {
    try {
      const headDeployment = await deployOps.getOrCreateHeadDeployment(scriptId);
      if (!headDeployment.webAppUrl) {
        return {
          success: false,
          error: 'HEAD deployment created but returned no web app URL — ensure the script has a web app entry point configured in appsscript.json',
          hints: { fix: 'Add webapp access config to appsscript.json, redeploy, then retry' },
        };
      }
      headUrl = headDeployment.webAppUrl;
      // Cache for future calls
      await setDeploymentInfo(resolvedDir, scriptId, {
        headUrl,
        headDeploymentId: headDeployment.deploymentId,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to get HEAD deployment: ${message}`,
        hints: { fix: 'Check authentication and ensure the script has a web app entry point' },
      };
    }
  }

  // AUTO_PUSH: always push all local files before exec
  let filesSync = 0;

  try {
    const pushResult = await push(scriptId, resolvedDir, fileOps);

    if (!pushResult.success) {
      return {
        success: false,
        error: `Auto-push failed: ${pushResult.error}`,
        validationErrors: pushResult.validationErrors,
        hints: {
          fix: pushResult.validationErrors
            ? 'Fix the validation errors, then retry exec'
            : 'Check authentication and network, then retry',
          commonjs: 'GAS CommonJS: function _main(){ exports.fn=function(){...}; } __defineModule__(_main,false);',
        },
      };
    }

    filesSync = pushResult.filesPushed.length;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Auto-push failed: ${message}`,
      hints: { fix: 'Check authentication and try again' },
    };
  }

  // Execute via web app URL
  try {
    const token = await sessionManager.getValidToken();
    if (!token) {
      return {
        success: false,
        error: 'Not authenticated',
        hints: { fix: 'Run auth with action="login"' },
      };
    }

    // Build JS statement for the __mcp_exec.gs GET handler.
    // Uses the proven mcp_gas exec pattern: GET ?_mcp_run=true&func=<encoded_js>
    // POST to workspace-domain web apps triggers IAP redirect chains that reject Bearer tokens.
    // GET with redirect:follow successfully authenticates through the IAP redirect.
    const argsList = (args ?? []).map(a => JSON.stringify(a)).join(', ');
    const jsStatement = moduleName
      ? `require('${moduleName}').${functionName}(${argsList})`
      : `require('runner-api').${functionName}(${argsList})`;

    // headUrl is a HEAD deployment URL (ends in /dev) — accepts ?_mcp_run=true directly.
    // Normalize workspace domain to standard format so Bearer tokens are accepted.
    const normalizedUrl = normalizeWebAppUrl(headUrl);
    const separator = normalizedUrl.includes('?') ? '&' : '?';
    const execGetUrl = `${normalizedUrl}${separator}_mcp_run=true&func=${encodeURIComponent(jsStatement)}`;

    const signal = AbortSignal.timeout(30_000);
    const response = await fetch(execGetUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      redirect: 'follow',
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      // If HTML response, likely needs browser auth (one-time per project)
      const isHtml = text.trimStart().startsWith('<!');
      return {
        success: false, filesSync,
        error: isHtml
          ? `Web app needs browser authorization. Visit the URL in Chrome to authorize: ${normalizedUrl}`
          : `Execution failed (HTTP ${response.status}): ${text}`,
        hints: {
          fix: isHtml
            ? 'Open the deployment URL in a browser signed in as the script owner, then retry exec'
            : 'Check the function name and deployment configuration',
          exports: 'Function must be exported inside _main(): exports.myFn = function(){...} — bare function declarations are NOT callable via exec',
        },
      };
    }

    // Response format from __mcp_exec.gs: { success, result, logger_output } or { success, error, logger_output }
    const data = await response.json() as {
      success?: boolean;
      result?: unknown;
      error?: string;
      logger_output?: string;
    };

    if (data.success === false) {
      return {
        success: false, filesSync,
        error: data.error ?? 'Unknown execution error',
        logs: data.logger_output,
        hints: { fix: 'Check the function and module names, ensure function is exported inside _main()' },
      };
    }

    return {
      success: true,
      result: data.result,
      logs: data.logger_output,
      filesSync,
      hints: {
        next: `Function executed. ${filesSync} files pushed before execution.`,
        commonjs: 'GAS CommonJS: function _main(){ exports.fn=function(){...}; } __defineModule__(_main,false);',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, filesSync,
      error: `Execution failed: ${message}`,
      hints: { fix: 'Check the deployment URL and function name' },
    };
  }
}
