/**
 * Consumer Shim Utilities for mcp-gas-deploy
 *
 * Pure functions (no API calls, no side-effects) for generating thin proxy shim
 * code and consumer manifests for GAS library consumer projects.
 *
 * Consumer projects are "proxy" scripts that reference a source library and
 * re-export all its handlers. When the source project is deployed as a library,
 * these shims keep consumer projects in sync automatically.
 */

/**
 * Validate userSymbol is a valid JavaScript identifier.
 * Throws with a clear message if invalid — called before any API call.
 */
export function validateUserSymbol(userSymbol: string): void {
  // Must be a valid GAS library namespace: letters, digits, underscores only.
  // Mirrors the canonical mcp_gas validator — $ is excluded to match that constraint.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(userSymbol)) {
    throw new Error(
      `Invalid userSymbol "${userSymbol}": must be a valid JavaScript identifier ` +
      `(letters, numbers, underscores only; cannot start with a digit)`
    );
  }
}

/**
 * Generate thin proxy shim code mirroring the mcp_gas generateThinShim pattern.
 * All event handlers delegate to the library via userSymbol.
 *
 * The generated shim exports: onOpen, onInstall, onEdit, exec_api,
 * showSidebar, initialize, menuAction1, menuAction2.
 */
export function generateShimCode(userSymbol: string): string {
  return `// Auto-generated consumer shim — do not edit manually
// Delegates all calls to library: ${userSymbol}

// Pass bound spreadsheet context to standalone library before every call
function _setLibraryContext() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) ${userSymbol}.setContext({ spreadsheetId: ss.getId() });
  } catch(e) { /* standalone — no active spreadsheet */ }
}

function onOpen(e) { _setLibraryContext(); return ${userSymbol}.onOpen(e); }
function onInstall(e) { _setLibraryContext(); return ${userSymbol}.onOpen(e); }
function onEdit(e) { _setLibraryContext(); return ${userSymbol}.onEdit(e); }
function exec_api(options, moduleName, functionName) { _setLibraryContext(); return ${userSymbol}.exec_api.apply(null, arguments); }
function showSidebar() { _setLibraryContext(); return ${userSymbol}.showSidebar(); }
function initialize() { _setLibraryContext(); return ${userSymbol}.initialize(); }
function menuAction1() { _setLibraryContext(); return ${userSymbol}.menuAction1(); }
function menuAction2() { _setLibraryContext(); return ${userSymbol}.menuAction2(); }
`;
}

/**
 * Build consumer appsscript.json content.
 *
 * When sourceVersionNumber is provided (deploy flow), uses developmentMode: false and
 * the exact source version number so the consumer is pinned to the specific snapshot that
 * was just deployed. This ensures the consumer runs against the same tested version —
 * not whatever HEAD happens to be at runtime if someone pushes new source files later.
 *
 * When sourceVersionNumber is omitted (e.g. tests or manual use), falls back to
 * developmentMode: true + version "0" (GAS HEAD resolution — always latest push).
 *
 * oauthScopes and timeZone are copied from the source project's manifest when available.
 */
export function buildConsumerManifest(
  sourceScriptId: string,
  userSymbol: string,
  oauthScopes?: string[],
  timeZone?: string,
  sourceVersionNumber?: number
): object {
  const manifest: Record<string, unknown> = {
    timeZone: timeZone ?? 'America/New_York',
    dependencies: {
      libraries: [
        {
          userSymbol,
          libraryId: sourceScriptId,
          // Pin to exact deployed version when known; fall back to HEAD (developmentMode: true)
          version: sourceVersionNumber != null ? String(sourceVersionNumber) : '0',
          developmentMode: sourceVersionNumber == null,
        },
      ],
    },
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
  };

  if (oauthScopes && oauthScopes.length > 0) {
    manifest.oauthScopes = oauthScopes;
  }

  return manifest;
}
