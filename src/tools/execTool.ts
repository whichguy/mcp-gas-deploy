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
import { buildHintContext } from '../utils/hintContext.js';
import { SessionManager } from '../auth/sessionManager.js';
import { SCRIPT_ID_PATTERN, FUNCTION_PATTERN, MODULE_NAME_PATTERN } from '../utils/validation.js';
import { executeRawJs } from '../utils/gasExecutor.js';
import type { ValidationResult } from '../validation/commonjsValidator.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

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
  description: '[EXEC] Execute a GAS function via web app URL — auto-pushes local files first. WHEN: testing a function, verifying deployed behavior. AVOID: run deploy first if no web app URL exists. Example: exec({scriptId: "1abc...", function: "myFn", args: []})',
  annotations: {
    title: 'Execute GAS Function',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      ...SchemaFragments.localDir,
      module: {
        type: 'string',
        description: 'Module path, e.g. "common-js/utils". Calls require(module)[function](...args). Omit to route via runner-api.',
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
    additionalProperties: false,
    llmGuidance: {
      requirements: 'Web app deployment must exist — run deploy first if none. Function must be exported inside _main(): exports.myFn = function() { ... }',
      module: 'Use "common-js/<name>" (e.g. "common-js/utils") to call a module function directly. Omit to route via runner-api (default).',
      autoPush: 'All local files are pushed before execution (with CommonJS validation). Fix validation errors before retrying.',
      browserAuth: 'If exec returns a browser authorization error, open the HEAD deployment URL in Chrome signed in as the script owner, then retry.',
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      result: {},
      logs: { type: 'string' },
      filesSync: { type: 'number' },
      validationErrors: { type: 'array' },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success'],
  },
};

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

  if (functionName.endsWith('_')) {
    return {
      success: false,
      error: `Function "${functionName}" ends with _ — GAS treats trailing-underscore functions as private and they cannot be called externally`,
      hints: { fix: 'Remove the trailing underscore or rename the function' },
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
      hints: { fix: 'No deployment URL found in gas-deploy.json (checked headUrl, stagingUrl, prodUrl). Run action=deploy to create a web app deployment, then retry exec.' },
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
    const argsList = (args ?? []).map(a => JSON.stringify(a)).join(', ');
    const jsStatement = moduleName
      ? `require('${moduleName}').${functionName}(${argsList})`
      : `require('runner-api').${functionName}(${argsList})`;

    const rawResult = await executeRawJs(jsStatement, headUrl, token);

    if (!rawResult.success) {
      const isBrowserAuth = rawResult.error?.includes('browser authorization');
      return {
        success: false, filesSync,
        error: rawResult.error,
        logs: rawResult.logs,
        hints: {
          fix: isBrowserAuth
            ? 'Open the deployment URL in a browser signed in as the script owner, then retry exec'
            : 'Check the function and module names, ensure function is exported inside _main().',
          ...(isBrowserAuth
            ? { exports: 'Function must be exported inside _main(): exports.myFn = function(){...} — bare function declarations are NOT callable via exec' }
            : { invocation: jsStatement }),
        },
      };
    }

    return {
      success: true,
      result: rawResult.result,
      logs: rawResult.logs,
      filesSync,
      hints: {
        next: `Function executed. ${filesSync} files pushed before execution.`,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, filesSync,
      error: `Execution failed: ${message}`,
      hints: {
        fix: `Execution failed against ${headUrl ?? 'unknown URL'}. Check the deployment URL and function name.`,
        context: buildHintContext(deployInfo),
      },
    };
  }
}
