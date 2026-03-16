#!/usr/bin/env bash
# Syncs runtime files from mcp_gas into runtime/ directory.
# Usage: npm run sync-runtime [-- path/to/mcp_gas]
set -euo pipefail
MCP_GAS="${1:-$HOME/src/mcp_gas}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/runtime"
mkdir -p "$DEST"
cp "$MCP_GAS/gas-runtime/common-js/require.gs"       "$DEST/require.gs"
cp "$MCP_GAS/src/templates/ConfigManager.template.js" "$DEST/ConfigManager.gs"
cp "$MCP_GAS/gas-runtime/common-js/__mcp_exec.gs"     "$DEST/__mcp_exec.gs"
cp "$MCP_GAS/gas-runtime/common-js/html_utils.gs"     "$DEST/html_utils.gs"
cp "$MCP_GAS/src/__mcp_exec_success.html"              "$DEST/__mcp_exec_success.html"
cp "$MCP_GAS/src/__mcp_exec_error.html"                "$DEST/__mcp_exec_error.html"
echo "Synced 6 runtime files from $MCP_GAS → $DEST"
