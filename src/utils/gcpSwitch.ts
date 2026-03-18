/**
 * GCP Project Switch Utility
 *
 * Programmatically associates a GAS project with a Standard GCP project
 * via the undocumented batchexecute RPC (rpcid i8hYdd), enabling
 * scripts.run API without browser auth.
 *
 * Requires chrome-devtools MCP server for browser session access.
 */

export interface GcpSwitchResult {
  success: boolean;
  scriptId: string;
  gcpProjectNumber: string;
  error?: string;
  hint?: string;
}

export interface ChromeDevtools {
  navigate_page: (args: { url: string }) => Promise<unknown>;
  evaluate_script: (args: { expression: string }) => Promise<{ result?: string }>;
}

/**
 * Switch a GAS project's GCP project via internal batchexecute RPC.
 *
 * @param scriptId - GAS project script ID
 * @param gcpProjectNumber - Standard GCP project number (e.g. "428972970708")
 * @param chromeDevtools - chrome-devtools MCP client (navigate_page + evaluate_script)
 * @returns Result with success status
 */
export async function switchGcpProject(
  scriptId: string,
  gcpProjectNumber: string,
  chromeDevtools: ChromeDevtools
): Promise<GcpSwitchResult> {
  const base = { scriptId, gcpProjectNumber };

  if (!scriptId || !gcpProjectNumber) {
    return {
      ...base,
      success: false,
      error: 'Both scriptId and gcpProjectNumber are required',
      hint: 'Find your Standard GCP project number at console.cloud.google.com > project settings.',
    };
  }

  try {
    // Step 1: Navigate to the project settings page to get session tokens
    const settingsUrl = `https://script.google.com/home/projects/${scriptId}/settings`;
    await chromeDevtools.navigate_page({ url: settingsUrl });

    // Step 2: Extract XSRF token and session data from WIZ_global_data
    const tokenScript = `
      (function() {
        try {
          var xsrf = typeof WIZ_global_data !== 'undefined' && WIZ_global_data.SNlM0e;
          var session = typeof WIZ_global_data !== 'undefined' && WIZ_global_data['.FdrFJe'];
          var buildLabel = typeof WIZ_global_data !== 'undefined' && WIZ_global_data['.cfb2h'];
          if (!xsrf) return JSON.stringify({ error: 'XSRF token not found — not signed in to Google in this browser' });
          return JSON.stringify({ xsrf: xsrf, session: session || '', buildLabel: buildLabel || '' });
        } catch(e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    const tokenResult = await chromeDevtools.evaluate_script({ expression: tokenScript });
    const tokenData = JSON.parse(tokenResult.result ?? '{}');

    if (tokenData.error) {
      const isSignInError = String(tokenData.error).includes('not signed in');
      if (isSignInError) {
        // Navigate Chrome to Google sign-in so the user can authenticate and retry
        try {
          await chromeDevtools.navigate_page({ url: 'https://accounts.google.com' });
          console.error('[mcp-gas-deploy] GCP switch: Chrome is not signed in to Google.');
          console.error('[mcp-gas-deploy] Chrome has been navigated to accounts.google.com.');
          console.error('[mcp-gas-deploy] Sign in to Google in the Chrome window, then retry fork.');
        } catch { /* non-fatal — original error still returned */ }
      }
      return {
        ...base,
        success: false,
        error: isSignInError
          ? 'Not signed in to Google in this browser. Chrome has been navigated to accounts.google.com — sign in, then retry fork.'
          : `Token extraction failed: ${tokenData.error}`,
        hint: isSignInError
          ? 'Chrome has been navigated to accounts.google.com — sign in, then retry fork.'
          : 'Open Chrome, sign in to Google, then retry fork.',
      };
    }

    // Step 3: Execute batchexecute RPC to switch GCP project
    const rpcScript = `
      (function() {
        try {
          var xsrf = ${JSON.stringify(tokenData.xsrf)};
          var payload = JSON.stringify([[${JSON.stringify(scriptId)}, ${JSON.stringify(gcpProjectNumber)}]]);
          var body = 'f.req=' + encodeURIComponent('[[["i8hYdd","' + payload.replace(/"/g, '\\\\"') + '",null,"generic"]]]')
            + '&at=' + encodeURIComponent(xsrf);
          return fetch('https://script.google.com/_/AppsMakerSidekickUi/data/batchexecute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            credentials: 'include'
          })
          .then(function(r) { return r.text(); })
          .then(function(text) {
            if (text.indexOf('"[1]"') !== -1 || text.indexOf('[1]') !== -1) {
              return JSON.stringify({ success: true });
            }
            var errorMatch = text.match(/\\[4,1,"([^"]+)"\\]/);
            var errorMsg = errorMatch ? errorMatch[1] : 'Unknown batchexecute error';
            return JSON.stringify({ success: false, error: errorMsg, raw: text.substring(0, 500) });
          });
        } catch(e) {
          return Promise.resolve(JSON.stringify({ error: e.message }));
        }
      })()
    `;

    const rpcResult = await chromeDevtools.evaluate_script({ expression: rpcScript });
    const rpcData = JSON.parse(rpcResult.result ?? '{}');

    if (rpcData.error) {
      return {
        ...base,
        success: false,
        error: `GCP switch RPC failed: ${rpcData.error}`,
        hint: 'The batchexecute RPC (i8hYdd) may have changed. Fallback: manually switch GCP project in script.google.com > Project Settings.',
      };
    }

    if (!rpcData.success) {
      return {
        ...base,
        success: false,
        error: rpcData.error ?? 'GCP switch returned unsuccessful response',
        hint: 'Check that the GCP project number is correct and you have owner access to both the script and GCP project.',
      };
    }

    return { ...base, success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      success: false,
      error: `GCP switch failed: ${message}`,
      hint: 'Ensure chrome-devtools MCP server is running and Chrome is signed in to Google.',
    };
  }
}
