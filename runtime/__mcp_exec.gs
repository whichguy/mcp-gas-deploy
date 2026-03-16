// --- Top-level functions (outside _main) for scripts.run API ---
// These run during V8 file loading, before any module code.
// Using globalThis[] makes them accessible from any file loaded via require().

/**
 * Set execution context on globalThis — accessible across ALL files.
 * Consumer shim calls this before exec_api() to pass bound spreadsheet ID.
 */
function setContext(ctx) {
  if (ctx.spreadsheetId) globalThis.__SPREADSHEET_ID__ = ctx.spreadsheetId;
  if (ctx.ui) globalThis.__UI__ = ctx.ui;
}

/**
 * Transparent replacement for getActiveSpreadsheet().
 * Works in both container-bound (native) and standalone (configured ID) contexts.
 */
function getSpreadsheet() {
  if (globalThis.__SPREADSHEET_ID__) return SpreadsheetApp.openById(globalThis.__SPREADSHEET_ID__);
  try { var ss = SpreadsheetApp.getActiveSpreadsheet(); if (ss) return ss; } catch(e) {}
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (id) return SpreadsheetApp.openById(id);
  } catch(e) {}
  return null;
}

globalThis.getSpreadsheet = getSpreadsheet;
globalThis.setContext = setContext;

/**
 * Top-level entry point for scripts.run API.
 * Executes arbitrary JS via Function constructor for dynamic code evaluation.
 * Intentionally uses Function constructor for dynamic JS execution.
 */
function apiExec(params) {
  try {
    if (params && params.spreadsheetId) globalThis.__SPREADSHEET_ID__ = params.spreadsheetId;
    var func = (params && params.func) ? params.func : 'return null';
    // eslint-disable-next-line no-new-func -- intentional dynamic execution entry point
    var result = (new Function(func))();
    return { success: true, result: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  __events__ = module.__events__,
  __global__ = module.__global__
) {
  // scripts.run-only runtime — no doGet/doPost, no web-app exec infrastructure.
  // All execution goes through the top-level apiExec() function.
}

__defineModule__(_main, 'common-js/__mcp_exec', {loadNow: true});
