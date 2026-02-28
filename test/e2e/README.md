# E2E Test Plan: mcp-gas-deploy Round-Trip

Validates the full **push → deploy → exec** chain using the `mcp-gas-deploy` MCP tools
against a real GAS project on Google's servers.

---

## Prerequisites

1. Claude Code restarted after MCP registration (so `mcp-gas-deploy` tools are available)
2. Authenticated: `auth` tool with `action="login"` must succeed
3. A test GAS project created manually in Google Apps Script UI (one-time setup)
   — copy the resulting script ID (e.g. `ABC123...`)

---

## Project File Structure

Push this exact set of files to the test project (all in `test/e2e/gas-files/`):

```
require.gs          ← CommonJS runtime (copy from ~/src/mcp_gas/gas-runtime/common-js/require.gs)
dispatcher.gs       ← doPost handler — routes { function, parameters } to module exports
hello.gs            ← simple test module with greet() function
test-framework/
  mocha-adapter.gs  ← copy from ~/.claude-worktrees/.../clever-goodall/test-framework/
  test-runner.gs
  test-registry.gs
  diff-utils.gs
  fix-hints.gs
hello.test.gs       ← test file using mocha-adapter describe/it/expect
runner-api.gs       ← exposes runTests() → test-runner.runAllTests() for exec to call
```

**File order matters** — `require.gs` MUST be at position 0.

---

## Setup Script

Run once to copy the test framework files from the worktree:

```bash
WORKTREE=~/.claude-worktrees/project-1Y72rigcMUAwRd7bwl3CR57O6ENo5sKTn0xAl2C4HoZys75N5utGfkCUG/clever-goodall
cp ~/src/mcp_gas/gas-runtime/common-js/require.gs test/e2e/gas-files/
cp $WORKTREE/test-framework/mocha-adapter.gs test/e2e/gas-files/test-framework/
cp $WORKTREE/test-framework/test-runner.gs    test/e2e/gas-files/test-framework/
cp $WORKTREE/test-framework/test-registry.gs  test/e2e/gas-files/test-framework/
cp $WORKTREE/test-framework/diff-utils.gs     test/e2e/gas-files/test-framework/
cp $WORKTREE/test-framework/fix-hints.gs      test/e2e/gas-files/test-framework/
```

The remaining files (`dispatcher.gs`, `hello.gs`, `hello.test.gs`, `runner-api.gs`)
are already in this directory.

---

## Exec Protocol

`mcp-gas-deploy`'s `exec` tool POSTs to the web app URL:
```json
{ "function": "greet", "parameters": [] }
```

`dispatcher.gs` handles this by calling `require('runner-api')[fnName](...parameters)`.
All callable functions must be exported from `runner-api.gs`.

---

## Test Steps

### Step 1 — Auth
```
exec tool: auth { action: "login" }
```
Verify: `success: true`, user email shown.

### Step 2 — Pull existing project (first-time sync)
```
exec tool: pull { scriptId: "<YOUR_SCRIPT_ID>" }
```
Verify: `success: true`, `localDir` created at `~/gas-projects/<scriptId>`.

### Step 3 — Copy test files to localDir
```bash
cp -r test/e2e/gas-files/* ~/gas-projects/<scriptId>/
```

### Step 4 — Check status
```
exec tool: status { scriptId: "<YOUR_SCRIPT_ID>" }
```
Verify: local-ahead files listed (all the new files we added).

### Step 5 — Push (validates CommonJS headers)
```
exec tool: push { scriptId: "<YOUR_SCRIPT_ID>" }
```
Verify: `success: true`, all files pushed, no `validationErrors`.
If validation fails: check that all `.gs` files have `function _main()` + `__defineModule__`.

### Step 6 — Deploy to staging
```
exec tool: deploy { scriptId: "<YOUR_SCRIPT_ID>", to: "staging" }
```
Verify: `success: true`, `webAppUrl` returned, stored in `gas-deploy.json`.

### Step 7 — Exec: sanity check (greet)
```
exec tool: exec { scriptId: "<YOUR_SCRIPT_ID>", function: "greet" }
```
Verify: `result: "Hello from GAS!"`, `syncedBeforeExec: false`.

### Step 8 — Exec: run tests on GAS runtime
```
exec tool: exec { scriptId: "<YOUR_SCRIPT_ID>", function: "runTests" }
```
Verify: result contains `passed: N`, `failed: 0`, test names visible.
Expected output (from test-runner):
```
📊 3/3 (100%) [0 skipped]
✓ greet returns a string (Xms)
✓ greet contains 'Hello' (Xms)
✓ greet contains 'GAS' (Xms)
```

### Step 9 — Verify sync state (optional)
```
exec tool: status { scriptId: "<YOUR_SCRIPT_ID>" }
```
Verify: `inSync: N`, `localAhead: 0`, `remoteAhead: 0` — confirms sync state tracking works.

---

## Expected Validation Points

| Check | Pass Condition |
|-------|---------------|
| push validates CommonJS | No validationErrors returned |
| require.gs at position 0 | No REQUIRE_POSITION error |
| All functions exported in _main | No TOP_LEVEL_EXPORTS error |
| exec dispatches correctly | greet() returns correct string |
| GAS test runner passes | 0 failures from runTests() |
| sync state tracking | remoteAhead=0 after push+deploy |

---

## Teardown

After testing, the test GAS project can be left in place or deleted via the Apps Script UI.
Local files remain at `~/gas-projects/<scriptId>/`.
