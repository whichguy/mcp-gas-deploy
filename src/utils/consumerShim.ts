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

function onOpen(e) { return ${userSymbol}.onOpen(e); }
function onInstall(e) { return ${userSymbol}.onOpen(e); }
function onEdit(e) { return ${userSymbol}.onEdit(e); }
function exec_api(options, moduleName, functionName) { return ${userSymbol}.exec_api.apply(null, arguments); }
function showSidebar() { return ${userSymbol}.showSidebar(); }
function initialize() { return ${userSymbol}.initialize(); }
function menuAction1() { return ${userSymbol}.menuAction1(); }
function menuAction2() { return ${userSymbol}.menuAction2(); }
`;
}

/**
 * Build consumer appsscript.json content.
 *
 * Always uses developmentMode: true (which causes GAS to resolve HEAD of the library
 * at runtime, ignoring the version field). version "0" is included for clarity but is
 * inert when developmentMode is true. Subsequent source pushes are reflected automatically
 * without a new consumer version.
 *
 * oauthScopes and timeZone are copied from the source project's manifest when available.
 */
export function buildConsumerManifest(
  sourceScriptId: string,
  userSymbol: string,
  oauthScopes?: string[],
  timeZone?: string
): object {
  const manifest: Record<string, unknown> = {
    timeZone: timeZone ?? 'America/New_York',
    dependencies: {
      libraries: [
        {
          userSymbol,
          libraryId: sourceScriptId,
          version: '0',
          developmentMode: true,
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
