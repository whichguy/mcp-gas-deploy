/**
 * Shared HTTP executor for GAS web app calls.
 *
 * Encapsulates URL normalization, redirect following with token safety,
 * HTML-200 detection, and JSON response parsing. Used by execTool (push+execute)
 * and triggerTool (ScriptApp IIFE execution).
 */

export interface RawJsResult {
  success: boolean;
  result?: unknown;
  logs?: string;
  error?: string;
}

/**
 * Convert a workspace-domain web app URL to the standard format that accepts Bearer tokens.
 *
 * Workspace URLs (https://script.google.com/a/macros/<domain>/s/<id>/exec) trigger
 * Google Workspace IAP, which rejects programmatic Bearer tokens.
 * Standard URLs (https://script.google.com/macros/s/<id>/exec) accept Bearer tokens.
 */
export function normalizeWebAppUrl(url: string): string {
  return url.replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    'https://script.google.com/macros/s/'
  );
}

/**
 * Escape a string for safe interpolation into GAS IIFE code templates.
 * Prevents code injection via user-controlled inputs (functionName, triggerId, etc.).
 */
export function escapeGasString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Execute a raw JavaScript statement against a GAS web app HEAD deployment.
 *
 * Redirect safety model: follows up to 5 redirects, forwarding the Bearer token
 * only to *.google.com and *.googleusercontent.com hosts. Redirects to any other
 * domain stop the chain to prevent token leakage.
 *
 * HTML-200 detection: if the response is HTTP 200 but content-type is text/html,
 * this signals a browser authorization page — GAS web apps require one-time owner
 * authorization via browser on new projects.
 */
export async function executeRawJs(
  jsStatement: string,
  headUrl: string,
  token: string,
  timeoutMs: number = 30_000,
): Promise<RawJsResult> {
  const normalizedUrl = normalizeWebAppUrl(headUrl);
  const separator = normalizedUrl.includes('?') ? '&' : '?';
  const execUrl = `${normalizedUrl}${separator}_mcp_run=true`;

  // Follow redirects manually so the Bearer token is only forwarded to *.google.com hops.
  // GAS web apps use an IAP redirect chain (script.google.com → accounts.google.com) before
  // serving the response; redirect:'follow' would send the token to any redirect target.
  const signal = AbortSignal.timeout(timeoutMs);
  let response = await fetch(execUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ func: jsStatement }),
    redirect: 'manual',
    signal,
  });

  let redirectHops = 0;
  let currentUrl = execUrl;
  while ((response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) && redirectHops < 5) {
    const location = response.headers.get('location');
    if (!location) break;
    const redirectUrl = new URL(location, currentUrl);
    currentUrl = redirectUrl.toString();

    // Security: only forward Bearer token to Google-owned domains
    const isGoogleHost = redirectUrl.hostname.endsWith('.google.com')
      || redirectUrl.hostname === 'google.com'
      || redirectUrl.hostname.endsWith('.googleusercontent.com');
    if (!isGoogleHost) break;

    redirectHops++;
    response = await fetch(redirectUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      redirect: 'manual',
      signal,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    const isHtml = text.trimStart().startsWith('<!');
    if (isHtml) {
      return {
        success: false,
        error: `Web app needs browser authorization. Visit the URL in Chrome to authorize: ${normalizedUrl}`,
      };
    }
    return {
      success: false,
      error: `Execution failed (HTTP ${response.status}): ${text}`,
    };
  }

  // A 200 OK with text/html content-type means a browser authorization page —
  // GAS web apps require one-time owner authorization via browser on new projects.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    return {
      success: false,
      error: `Web app needs browser authorization. Visit the URL in Chrome to authorize: ${normalizedUrl}`,
    };
  }

  // Response format from __mcp_exec.gs: { success, result, logger_output } or { success, error, logger_output }
  const data = await response.json() as {
    success?: boolean;
    result?: unknown;
    error?: string;
    logger_output?: string;
  };

  if (data.success !== true) {
    return {
      success: false,
      error: typeof data.error === 'string'
        ? data.error
        : data.error != null
          ? JSON.stringify(data.error)
          : 'Unknown execution error',
      logs: data.logger_output,
    };
  }

  return {
    success: true,
    result: data.result,
    logs: data.logger_output,
  };
}
