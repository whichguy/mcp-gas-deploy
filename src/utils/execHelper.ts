/**
 * Internal exec wrapper for GAS-side operations used by the promote tool.
 *
 * Unlike the full execTool (which auto-pushes files, validates CommonJS, etc.),
 * execHelper is a thin routing wrapper: scripts.run first, web app fallback.
 * No file I/O, no parameter modes, no validation beyond what's needed.
 *
 * Used for ConfigManager reads/writes, sheet sync, and property sync
 * during promote operations.
 */

import { executeViaScriptsRun } from './scriptsRunExecutor.js';
import { executeRawJs } from './gasExecutor.js';
import type { SessionManager } from '../auth/sessionManager.js';

export interface InternalExecResult {
  success: boolean;
  result?: unknown;
  logs?: string;
  error?: string;
}

/**
 * Execute JS on a GAS project — tries scripts.run first, falls back to web app URL.
 *
 * @param scriptId - GAS project script ID
 * @param jsStatement - JavaScript statement to execute (must start with 'return' for IIFEs)
 * @param sessionManager - for token retrieval
 * @param options - optional headUrl for web app fallback, spreadsheetId for context, timeout
 */
export async function execInternal(
  scriptId: string,
  jsStatement: string,
  sessionManager: SessionManager,
  options?: { spreadsheetId?: string; headUrl?: string; timeoutMs?: number }
): Promise<InternalExecResult> {
  let token: string | null = null;
  try {
    token = await sessionManager.getValidToken();
  } catch {
    return {
      success: false,
      error: 'Not authenticated. Run auth action="login" first.',
    };
  }

  if (!token) {
    return {
      success: false,
      error: 'Not authenticated. Run auth action="login" first.',
    };
  }

  // Try scripts.run first
  const scriptsRunResult = await executeViaScriptsRun(scriptId, jsStatement, token, {
    spreadsheetId: options?.spreadsheetId,
    timeoutMs: options?.timeoutMs,
  });

  if (scriptsRunResult.success) {
    return {
      success: true,
      result: scriptsRunResult.result,
      logs: scriptsRunResult.logs,
    };
  }

  // On 404 (not GCP-switched), try web app fallback if headUrl provided
  const is404 = scriptsRunResult.error?.includes('scripts.run 404:') === true;
  if (is404 && options?.headUrl) {
    const rawResult = await executeRawJs(
      jsStatement,
      options.headUrl,
      token,
      options.timeoutMs
    );
    return {
      success: rawResult.success,
      result: rawResult.result,
      logs: rawResult.logs,
      error: rawResult.error,
    };
  }

  return {
    success: false,
    error: scriptsRunResult.error,
  };
}

/**
 * Read a ConfigManager script-scope value from a GAS project.
 * Returns null if not found or on error.
 *
 * Uses JSON.stringify for key to prevent JS injection.
 */
export async function getConfigValue(
  scriptId: string,
  key: string,
  sessionManager: SessionManager,
  options?: { headUrl?: string }
): Promise<string | null> {
  const jsStatement =
    `return (function(){var CM=require('common-js/ConfigManager');return new CM('DEPLOY').get(${JSON.stringify(key)},null)})()`;

  const result = await execInternal(scriptId, jsStatement, sessionManager, options);
  if (!result.success) return null;
  return typeof result.result === 'string' ? result.result : null;
}

/**
 * Write a ConfigManager script-scope value on a GAS project.
 * Throws on exec failure — callers should handle non-fatally.
 *
 * Uses JSON.stringify for key and value to prevent JS injection.
 */
export async function setConfigValue(
  scriptId: string,
  key: string,
  value: string,
  sessionManager: SessionManager,
  options?: { headUrl?: string }
): Promise<void> {
  const jsStatement =
    `return (function(){var CM=require('common-js/ConfigManager');new CM('DEPLOY').setScript(${JSON.stringify(key)},${JSON.stringify(value)});return true})()`;

  const result = await execInternal(scriptId, jsStatement, sessionManager, options);
  if (!result.success) {
    throw new Error(`setConfigValue failed for key ${JSON.stringify(key)}: ${result.error ?? 'unknown'}`);
  }
}
