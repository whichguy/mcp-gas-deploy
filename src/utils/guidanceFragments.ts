/**
 * Deduplicated LLM guidance blocks shared across multiple tools.
 *
 * Each fragment is a plain string — tool definitions embed them in
 * their llmGuidance JSON objects.
 */

export class GuidanceFragments {
  static readonly commonJsPattern = [
    'All .gs files use the GAS CommonJS module pattern:',
    '  function _main() { exports.fn = function() { ... }; }',
    '  __defineModule__(_main, false);  // false=lazy | true=eager (trigger files)',
    'New files: place in common-js/ folder using this pattern.',
    'Trigger files: assign __events__.onOpen = handler inside _main() with loadNow: true.',
  ].join('\n');

  static readonly deployWorkflow = [
    'Exec workflow: push → exec (scripts.run, no deploy needed, no browser auth).',
    'Deploy workflow (for stable URLs): push → deploy (staging) → promote (prod).',
    'Deploy is NOT a prerequisite for exec — deploy is for staging/prod web app slots only.',
    'Use status to check current state before any deploy action.',
    'Use list-versions to check version budget (200 cap).',
  ].join('\n');

  static readonly circularBuffer = [
    'Staging and prod each maintain a 4-slot circular buffer for rollback history.',
    'deploy writes to the next slot (oldest if all 4 full).',
    'rollback steps back one slot (no wrap — stops at oldest).',
    'Slot arrays are NOT modified during rollback — only activeSlotIndex changes.',
  ].join('\n');

  static readonly errorRecovery = [
    'Auth errors: re-run auth action="login" to refresh tokens.',
    'Scope errors: OAuth client may need additional scopes — check error message.',
    '404 from scripts.run: GCP project not switched — run fork tool to associate with Standard GCP project.',
    '403/404: verify scriptId is correct and you have edit access to the project.',
  ].join('\n');

  static readonly triggerSetup = [
    'Trigger target functions must be globally accessible.',
    'In CommonJS projects: __events__.fnName = handler inside _main() with loadNow: true.',
    'Max 20 triggers per user per script.',
  ].join('\n');

  static readonly claspResolution = [
    'scriptId is optional when localDir contains .clasp.json.',
    'Resolution cascade: (1) localDir + .clasp.json → read scriptId (explicit scriptId overrides); (2) localDir + explicit scriptId → use explicit; (3) no localDir + explicit scriptId → use CWD; (4) neither → error.',
    'Use the create tool to bootstrap new projects (creates .clasp.json, git init, etc.).',
    'To update .clasp.json with a new scriptId, use the create tool (which writes .clasp.json during bootstrap).',
  ].join('\n');

  static readonly createWorkflow = [
    'create bootstraps a complete project: manifest + runtime files (require, ConfigManager, __mcp_exec, html_utils) + push + git init.',
    'Next steps: exec directly via scripts.run (no deploy or browser auth needed). For stable web app URLs: deploy (staging) → promote (prod).',
    'Runtime files are bundled with mcp-gas-deploy — no external config needed.',
  ].join('\n');

  static readonly claspIgnore = [
    '.claspignore (gitignore-style) filters local files from push/status/preview.',
    'Patterns apply AFTER hardcoded filters (hidden files, extension whitelist).',
    'Pull is NOT filtered — all remote files are fetched regardless of .claspignore.',
  ].join('\n');

  static readonly forkWorkflow = [
    'fork creates an isolated GAS project for parallel development (worktrees, branches).',
    'Pipeline: copy source → push local files → GCP switch → scripts.run ready.',
    'Idempotent: returns existing fork if .clasp.json already has a branch mapping.',
    'GCP switch failure is non-fatal — fork falls back to web-app mode.',
    'After fork: use the exec tool with the forkScriptId (no deploy needed).',
  ].join('\n');

  static readonly branchMapping = [
    '.clasp.json supports branch-based scriptId mapping: { scriptId, branches: { branchName: scriptId } }.',
    'fork tool writes branch mappings and reads them for idempotent fork detection.',
    'Tools use the root scriptId from .clasp.json; branch resolution is handled by the fork tool only.',
  ].join('\n');

  static readonly scriptsRun = [
    'scripts.run API runs GAS code without browser auth or web app deployment.',
    'Requires: (1) executionApi.access in manifest, (2) GCP project switch, (3) script.scriptapp OAuth scope.',
    'Uses apiExec function (top-level in __mcp_exec.gs) with devMode: true.',
    'Supports spreadsheetId context passing for standalone projects accessing bound sheets.',
  ].join('\n');

  static readonly setupTool = [
    'setup has 3 operations: init (one-time GCP project setup), script (per-script scripts.run readiness), status (check state).',
    'Auto-detects: scriptId present → script; no oauth-config.json → init; otherwise → status.',
    'init: detects config state, best-effort enables Apps Script API, guides manual OAuth setup.',
    'script: GCP-switch → ensure executionApi.access in manifest → verify with test call.',
    'Requires chrome-devtools MCP for GCP switch (browser RPC). gcpProjectNumber from param or _config.',
    'Idempotent: script returns early if gcpSwitched already true in gas-deploy.json.',
  ].join('\n');

  static readonly libraryPromote = [
    'Library promote model: push files between -source libraries; consumers auto-update via HEAD.',
    'Workflow: setup (optional) → promote to=staging → test → promote to=prod.',
    'Auto-create: first promote auto-creates -source library + consumer spreadsheet.',
    'Sheet sync: copies spreadsheet tabs via GAS SpreadsheetApp (preserves formulas/formatting).',
    'Property sync: copies ConfigManager properties (excludes infrastructure keys).',
    'Fix-forward: no rollback — edit dev, re-promote staging, re-promote prod.',
  ].join('\n');

  static readonly propertiesCopyWorkflow = [
    'Script properties are synced automatically during promote (syncProperties: true by default).',
    'Property sync uses execHelper (scripts.run or web-app fallback) to read from source and write to target.',
    'Infrastructure keys (URLs, script IDs, deployment IDs) are excluded from sync.',
    'To sync manually: use promote({syncProperties: true}) or call execInternal with PropertiesService code.',
    'reconcileProperties: true deletes target-only keys not present in source (opt-in, default false).',
  ].join('\n');
}
