/**
 * MCP Token Broker
 *
 * GAS web app that delivers a scoped access token to a locally-running MCP server
 * via HTTP POST. Runs inside Google's trusted OAuth runtime — bypasses domain-blocked
 * external OAuth client IDs entirely.
 *
 * Deploy as: Execute as "User accessing the web app", access "Anyone".
 * The user sees a consent screen listing all declared oauthScopes on first visit.
 */

/**
 * Handle GET requests from the MCP auth bootstrap flow.
 *
 * Expected query params:
 *   port  — local server port (1024–65535, numeric)
 *   nonce — CSRF nonce (32-char hex)
 *
 * Validates both params, then renders Index.html with port, nonce, and the
 * user's access token embedded via scriptlets.
 */
function doGet(e) {
  var portStr = e.parameter.port;
  var nonce = e.parameter.nonce;

  var port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    return HtmlService.createHtmlOutput(
      '<html><body><h1>Setup Error</h1><p>Invalid port parameter. Expected a number between 1024 and 65535.</p></body></html>'
    );
  }

  if (!nonce || !/^[0-9a-f]{32}$/.test(nonce)) {
    return HtmlService.createHtmlOutput(
      '<html><body><h1>Setup Error</h1><p>Invalid nonce parameter. Expected a 32-character hex string.</p></body></html>'
    );
  }

  var token = ScriptApp.getOAuthToken();

  var template = HtmlService.createTemplateFromFile('Index');
  template.port = port;
  template.nonce = nonce;
  template.token = token;

  return template.evaluate()
    .setTitle('MCP Auth Setup')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
