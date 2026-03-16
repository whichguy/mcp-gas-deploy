/**
 * scripts.run Executor
 *
 * Alternative execution path using the Apps Script API scripts.run method.
 * Used for GCP-switched fork projects instead of the web app doPost path.
 *
 * Pure REST API call — no redirect chain, no HTML-200 detection, no URL normalization.
 */

export interface ScriptsRunResult {
  success: boolean;
  result?: unknown;
  logs?: string;
  error?: string;
  hint?: string;
}

/**
 * Execute JavaScript on a GAS project via the scripts.run API.
 *
 * Calls the `apiExec` function (top-level in __mcp_exec.gs) with devMode: true,
 * which runs against the HEAD (latest push) of the script — no versioned
 * deployment required.
 *
 * @param scriptId - GAS project script ID
 * @param jsStatement - Raw JavaScript to execute (passed as `func` param to apiExec)
 * @param token - OAuth Bearer token (must include script.scriptapp scope)
 * @param options - Optional: spreadsheetId for context, timeout
 */
export async function executeViaScriptsRun(
  scriptId: string,
  jsStatement: string,
  token: string,
  options?: { spreadsheetId?: string; timeoutMs?: number }
): Promise<ScriptsRunResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const url = `https://script.googleapis.com/v1/scripts/${scriptId}:run`;

  const params: Record<string, unknown> = { func: jsStatement };
  if (options?.spreadsheetId) {
    params.spreadsheetId = options.spreadsheetId;
  }

  const body = {
    function: 'apiExec',
    parameters: [params],
    devMode: true,
  };

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();

      if (response.status === 404) {
        return {
          success: false,
          error: `scripts.run 404: script not found or EXECUTION_API not enabled`,
          hint: 'Run fork tool to associate with a Standard GCP project, or verify executionApi.access is set in appsscript.json.',
        };
      }

      if (response.status === 403) {
        return {
          success: false,
          error: `scripts.run 403: ${text}`,
          hint: 'OAuth token may be missing script.scriptapp scope. Re-authenticate with: auth action="login".',
        };
      }

      return {
        success: false,
        error: `scripts.run failed (HTTP ${response.status}): ${text}`,
      };
    }

    const data = await response.json() as {
      done?: boolean;
      error?: { message?: string; code?: number; status?: string };
      response?: {
        '@type'?: string;
        result?: { success?: boolean; result?: unknown; error?: string };
      };
    };

    // scripts.run error response (script-level error)
    if (data.error) {
      return {
        success: false,
        error: data.error.message ?? `scripts.run error (code ${data.error.code})`,
        hint: data.error.status === 'PERMISSION_DENIED'
          ? 'Script requires additional OAuth scopes. Check appsscript.json oauthScopes and re-authenticate.'
          : undefined,
      };
    }

    // Extract apiExec result from the scripts.run response wrapper
    const apiResult = data.response?.result;
    if (!apiResult) {
      return {
        success: false,
        error: 'scripts.run returned no result — apiExec function may not be defined',
        hint: 'Ensure __mcp_exec.gs with apiExec is pushed to the project. Run push first.',
      };
    }

    if (!apiResult.success) {
      return {
        success: false,
        error: apiResult.error ?? 'apiExec returned success: false',
      };
    }

    return {
      success: true,
      result: apiResult.result,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('TimeoutError') || message.includes('abort')) {
      return {
        success: false,
        error: `scripts.run timed out after ${timeoutMs}ms`,
        hint: 'The script may be taking too long. Check for infinite loops or increase timeout.',
      };
    }
    return {
      success: false,
      error: `scripts.run failed: ${message}`,
    };
  }
}
