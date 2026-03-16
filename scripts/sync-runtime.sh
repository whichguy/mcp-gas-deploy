#!/usr/bin/env bash
# Syncs runtime files from mcp_gas into runtime/ directory.
# __mcp_exec.gs is maintained locally (stripped scripts.run-only version).
# Usage: npm run sync-runtime [-- path/to/mcp_gas]
set -euo pipefail
MCP_GAS="${1:-$HOME/src/mcp_gas}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/runtime"
mkdir -p "$DEST"
cp "$MCP_GAS/gas-runtime/common-js/require.gs"       "$DEST/require.gs"
cp "$MCP_GAS/src/templates/ConfigManager.template.js" "$DEST/ConfigManager.gs"
cp "$MCP_GAS/gas-runtime/common-js/html_utils.gs"     "$DEST/html_utils.gs"
echo "Synced 3 runtime files from $MCP_GAS → $DEST (__mcp_exec.gs maintained locally)"
