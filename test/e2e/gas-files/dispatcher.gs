function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module dispatcher
   * Web app doPost handler for mcp-gas-deploy exec protocol.
   *
   * Receives: POST { function: string, parameters: any[] }
   * Returns:  JSON { result: any } | { error: string }
   *
   * All callable functions must be exported from runner-api.gs.
   * Add new callable functions there, not here.
   */

  __events__.doPost = function(e) {
    try {
      const body = JSON.parse(e.postData.contents);
      const fnName = body['function'];
      const parameters = body.parameters ?? [];

      if (!fnName || typeof fnName !== 'string') {
        return jsonError('Missing or invalid "function" field in request body');
      }

      const api = require('runner-api');

      if (typeof api[fnName] !== 'function') {
        return jsonError(`Unknown function: "${fnName}". Available: ${Object.keys(api).join(', ')}`);
      }

      const result = api[fnName](...parameters);
      return ContentService
        .createTextOutput(JSON.stringify({ result }))
        .setMimeType(ContentService.MimeType.JSON);

    } catch (err) {
      return jsonError(err.message ?? String(err));
    }
  };

  function jsonError(message) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

__defineModule__(_main, true);
