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
    'Recommended workflow: push → deploy (staging) → exec (verify) → promote (prod).',
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
    'Missing HEAD: run deploy first to create a web app deployment.',
    '403/404: verify scriptId is correct and you have edit access to the project.',
  ].join('\n');

  static readonly triggerSetup = [
    'Trigger target functions must be globally accessible.',
    'In CommonJS projects: __events__.fnName = handler inside _main() with loadNow: true.',
    'Max 20 triggers per user per script.',
  ].join('\n');

  static readonly claspResolution = [
    'scriptId is optional when localDir contains .clasp.json.',
    'Resolution: localDir .clasp.json → explicit scriptId → error.',
    'Pull and push create .clasp.json automatically.',
    'Pass reparent=true to update .clasp.json when providing a different scriptId.',
  ].join('\n');

  static readonly propertiesCopyWorkflow = [
    'Script properties are NOT copied automatically. To copy them:',
    '1. exec in SOURCE project: require("runner-api").getScriptProperties() — returns all key/value pairs.',
    '2. exec in DESTINATION project: require("runner-api").setScriptProperties({...props}) — sets them.',
    'This requires a runner-api module with getScriptProperties/setScriptProperties exports.',
    'Alternative: manually set properties via PropertiesService in a custom function.',
  ].join('\n');
}
