/**
 * Exec Tool for mcp-gas-deploy
 *
 * Executes a GAS function via the web app deployment URL.
 * Auto-pushes all local files before execution.
 *
 * Pre-exec guard: if no web app URL in gas-deploy.json, returns actionable error.
 */

import { promises as fs } from 'node:fs';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { GASDeployOperations } from '../api/gasDeployOperations.js';
import { push } from '../sync/rsync.js';
import { getDeploymentInfo, setDeploymentInfo } from '../config/deployConfig.js';
import { buildHintContext } from '../utils/hintContext.js';
import { resolveProject } from '../utils/resolveProject.js';
import { SessionManager } from '../auth/sessionManager.js';
import { FUNCTION_PATTERN, MODULE_NAME_PATTERN } from '../utils/validation.js';
import { executeRawJs } from '../utils/gasExecutor.js';
import { executeViaScriptsRun } from '../utils/scriptsRunExecutor.js';
import type { ValidationResult } from '../validation/commonjsValidator.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';
import { getAuthHint } from '../utils/authHints.js';

export interface ExecToolParams {
  scriptId?: string;
  localDir?: string;
  js_statement?: string;
  module?: string;
  function?: string;
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
  description: '[EXEC] Run GAS code — auto-pushes local files first. Uses scripts.run first on all execs (no browser auth); falls back to web app URL on 404 if available. Two modes: (1) function mode: exec({scriptId, function, module?, args?}), (2) js_statement mode: exec({scriptId, js_statement}). WHEN: testing functions, verifying deployed behavior, running ad-hoc JS.',
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
      js_statement: {
        type: 'string',
        description: 'Raw JavaScript to send directly to executeRawJs(). Mutually exclusive with function/module/args. Must start with "return" to get a non-void result (e.g. "return SpreadsheetApp.getActive().getName()").',
        minLength: 1,
      },
      module: {
        type: 'string',
        description: 'Module path, e.g. "common-js/utils". Calls require(module)[function](...args). Omit to route via runner-api. Cannot be used with js_statement.',
      },
      function: {
        type: 'string',
        description: 'Function name — must be exported inside _main(): exports.<function> = function() {...}. Cannot be used with js_statement.',
      },
      args: {
        type: 'array',
        description: 'Arguments to pass to the function. Cannot be used with js_statement.',
        items: {},
      },
    },
    required: [],
    additionalProperties: false,
    llmGuidance: {
      requirements: 'For GCP-switched projects (forks): no deployment needed — scripts.run works directly. For non-switched projects: web app deployment must exist.',
      resolution: GuidanceFragments.claspResolution,
      modes: 'Two mutually exclusive modes: (1) function mode — provide "function" (+ optional "module", "args"); (2) js_statement mode — provide "js_statement" only (no function/module/args).',
      functionMode: 'Function must be exported inside _main(): exports.myFn = function() { ... }. Use "common-js/<name>" (e.g. "common-js/utils") to call a module function directly. Omit module to route via runner-api (default).',
      jsStatementMode: 'Send arbitrary JavaScript. MUST prefix with "return" for IIFEs and expressions (e.g. "return SpreadsheetApp.getActive().getName()"). Without "return", result will be undefined. Use require() to call module functions: "return require(\'common-js/utils\').myFn()".',
      autoPush: 'All local files are pushed before execution (with CommonJS validation). Fix validation errors before retrying.',
      browserAuth: 'For GCP-switched projects (forks), no browser auth needed — scripts.run bypasses web app consent. For non-switched projects, browser auth may be required on first use.',
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
  const { js_statement: jsStatementParam, module: moduleName, args } = params;
  const functionName = params.function;

  // js_statement mode: send raw JS directly; function mode: build require() call
  if (jsStatementParam && functionName) {
    return {
      success: false,
      error: 'Cannot provide both js_statement and function — they are mutually exclusive modes',
      hints: { fix: 'Use js_statement for raw JavaScript, OR function (+ optional module/args) for named function calls. Not both.' },
    };
  }
  if (!jsStatementParam && !functionName) {
    return {
      success: false,
      error: 'Must provide either js_statement or function',
      hints: { fix: 'Provide js_statement for raw JavaScript (e.g. "return 2+2"), or function for a named function call.' },
    };
  }
  if (jsStatementParam && moduleName) {
    return {
      success: false,
      error: 'Cannot use module with js_statement — module is only for function mode',
      hints: { fix: 'Use require() inside your js_statement instead: "return require(\'module\').fn()"' },
    };
  }
  if (jsStatementParam && args && args.length > 0) {
    return {
      success: false,
      error: 'Cannot use args with js_statement — args is only for function mode',
      hints: { fix: 'Embed arguments directly in your js_statement string.' },
    };
  }

  // Function mode validation: check function name and module name
  if (functionName) {
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
  }

  let resolved;
  try {
    resolved = await resolveProject({ scriptId: params.scriptId, localDir: params.localDir });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      hints: { fix: 'Provide scriptId explicitly, or point localDir to a directory with .clasp.json.' },
    };
  }

  const { scriptId, localDir: resolvedDir } = resolved;

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

  // Read deploy config for routing decision
  const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
  const isGcpSwitched = !!(deployInfo as Record<string, unknown>).gcpSwitched;

  // Resolve headUrl from config for web-app fallback after scripts.run 404
  const headUrl: string | undefined = deployInfo.headUrl;

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

  // Get auth token
  let token: string | null = null;
  try {
    token = await sessionManager.getValidToken();
  } catch {
    const hint = await getAuthHint(sessionManager);
    return {
      success: false,
      error: hint,
      hints: { fix: hint },
    };
  }
  if (!token) {
    const hint = await getAuthHint(sessionManager);
    return {
      success: false,
      error: hint,
      hints: { fix: hint },
    };
  }

  // Build JS statement: js_statement mode sends raw JS; function mode builds require() call
  let jsStatement: string;
  if (jsStatementParam) {
    jsStatement = jsStatementParam;
  } else {
    const argsList = (args ?? []).map(a => JSON.stringify(a)).join(', ');
    jsStatement = moduleName
      ? `require('${moduleName}').${functionName}(${argsList})`
      : `require('runner-api').${functionName}(${argsList})`;
  }

  // --- Execute: try scripts.run first, always ---
  const spreadsheetId = (deployInfo as Record<string, unknown>).spreadsheetId as string | undefined;
  const scriptsRunResult = await executeViaScriptsRun(scriptId, jsStatement, token, { spreadsheetId });

  if (scriptsRunResult.success) {
    // Opportunistically persist gcpSwitched if it wasn't already set
    if (!isGcpSwitched) {
      try { await setDeploymentInfo(resolvedDir, scriptId, { gcpSwitched: true }); } catch { /* non-fatal: best-effort persist */ }
    }

    const successHints: Record<string, string> = { execMode: 'scripts.run' };
    if (resolved.resolvedFrom === 'clasp-json') {
      successHints.scriptId = `Using scriptId ${scriptId} from .clasp.json`;
    }
    successHints.next = `${filesSync} files pushed. Executed via scripts.run.`;
    if (jsStatementParam && !jsStatementParam.trimStart().startsWith('return')) {
      successHints.returnPrefix = 'js_statement does not start with "return" — result will be undefined for expression-only code. Prefix with "return" for a non-void result.';
    }

    return {
      success: true,
      result: scriptsRunResult.result,
      logs: scriptsRunResult.logs,
      filesSync,
      hints: successHints,
    };
  }

  // scripts.run failed — inspect error
  const is404 = scriptsRunResult.error?.includes('scripts.run 404:') === true;
  const authHint = await getAuthHint(sessionManager);

  if (is404) {
    // Fall back to web-app if headUrl is available
    if (headUrl) {
      // --- Web-app fallback ---
      try {
        const rawResult = await executeRawJs(jsStatement, headUrl, token);

        if (!rawResult.success) {
          const isBrowserAuth = rawResult.error?.includes('browser authorization');
          const isJsStatementMode = !!jsStatementParam;

          const hints: Record<string, string> = {
            fix: isBrowserAuth
              ? 'Open the deployment URL in a browser signed in as the script owner, then retry exec'
              : isJsStatementMode
                ? 'Check your JavaScript statement for syntax or runtime errors.'
                : 'Check the function and module names, ensure function is exported inside _main().',
          };

          if (isBrowserAuth) {
            if (!isJsStatementMode) {
              hints.exports = 'Function must be exported inside _main(): exports.myFn = function(){...} — bare function declarations are NOT callable via exec';
            }
            hints.browserAuth = [
              `Automate browser auth with chrome-devtools MCP:`,
              `1. mcp__chrome-devtools__navigate_page url="${headUrl}" — opens the auth page`,
              `2. mcp__chrome-devtools__wait_for text="You need to authorize" — wait for consent UI`,
              `3. mcp__chrome-devtools__take_screenshot — verify the consent page loaded`,
              `4. mcp__chrome-devtools__click element="Allow" — click the Allow button (may need to identify by aria label or text)`,
              `5. mcp__chrome-devtools__wait_for text="can close" OR timeout 10s — wait for success`,
              `6. mcp__chrome-devtools__close_page — clean up`,
              `7. Retry exec — auth is now cached for this project`,
            ].join('\n');
          } else {
            hints.invocation = jsStatement;
          }

          return {
            success: false, filesSync,
            error: rawResult.error,
            logs: rawResult.logs,
            hints,
          };
        }

        // Return prefix hint: if js_statement mode and statement doesn't start with 'return', warn
        const successHints: Record<string, string> = {};
        if (resolved.resolvedFrom === 'clasp-json') {
          successHints.scriptId = `Using scriptId ${scriptId} from .clasp.json`;
        }
        successHints.next = `${jsStatementParam ? 'JavaScript statement' : 'Function'} executed. ${filesSync} files pushed before execution.`;
        if (jsStatementParam && !jsStatementParam.trimStart().startsWith('return')) {
          successHints.returnPrefix = 'js_statement does not start with "return" — result will be undefined for expression-only code. Prefix with "return" for a non-void result.';
        }

        return {
          success: true,
          result: rawResult.result,
          logs: rawResult.logs,
          filesSync,
          hints: successHints,
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

    // No cached headUrl — attempt to create/fetch HEAD deployment as fallback
    try {
      const headDeployment = await deployOps.getOrCreateHeadDeployment(scriptId);
      const resolvedHeadUrl = headDeployment.webAppUrl;
      if (resolvedHeadUrl) {
        // Cache for future calls
        try { await setDeploymentInfo(resolvedDir, scriptId, { headUrl: resolvedHeadUrl }); } catch { /* non-fatal */ }

        const rawResult = await executeRawJs(jsStatement, resolvedHeadUrl, token);
        if (!rawResult.success) {
          const isBrowserAuth = rawResult.error?.includes('browser authorization');
          return {
            success: false, filesSync,
            error: rawResult.error,
            hints: {
              fix: isBrowserAuth
                ? 'Open the deployment URL in a browser signed in as the script owner, then retry exec'
                : 'Check the function and module names.',
              ...(isBrowserAuth ? {
                browserAuth: [
                  `Automate browser auth with chrome-devtools MCP:`,
                  `1. mcp__chrome-devtools__navigate_page url="${resolvedHeadUrl}" — opens the auth page`,
                  `2. mcp__chrome-devtools__click element="Allow"`,
                  `3. Retry exec`,
                ].join('\n'),
              } : {}),
            },
          };
        }
        return {
          success: true,
          result: rawResult.result,
          logs: rawResult.logs,
          filesSync,
          hints: { execMode: 'web-app-fallback', next: `${filesSync} files pushed. Executed via web-app fallback (HEAD deployment).` },
        };
      }
    } catch { /* fall through to setup hint */ }

    // No web-app URL available — return setup hint
    return {
      success: false,
      filesSync,
      error: 'scripts.run returned 404: project is not linked to a Standard GCP project.',
      hints: {
        fix: 'Run setup operation=script with your GCP project number and chrome-devtools to enable direct execution.',
        learnMore: 'The GCP project must have the Apps Script API enabled. Find your project number in GCP Console → Project Settings.',
      },
    };
  }

  // Non-404 failure (auth error, timeout, etc.)
  return {
    success: false,
    filesSync,
    error: scriptsRunResult.error,
    hints: {
      fix: scriptsRunResult.hint ?? authHint,
      execMode: 'scripts.run (failed)',
    },
  };
}
