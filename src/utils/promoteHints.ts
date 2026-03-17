/**
 * Hint generation for promote and setup operations.
 * Pure functions — no side-effects.
 */

/**
 * Generate contextual hints for promote operations.
 */
export function generatePromoteHints(
  operation: 'promote' | 'status' | 'setup',
  environment?: 'staging' | 'prod',
  result?: Record<string, unknown>
): Record<string, string> {
  const hints: Record<string, string> = {};

  if (operation === 'promote') {
    if (environment === 'staging') {
      hints.next = 'Staging promote complete. Test in the staging spreadsheet, then run promote({to: "prod"}) to promote to production.';
      hints.fixForward = 'Fix-forward model: edit dev, re-run promote({to: "staging"}), then promote({to: "prod"}).';
    } else if (environment === 'prod') {
      hints.next = 'Production promote complete. Consumers now reference the prod-source library at HEAD.';
      hints.fixForward = 'Fix-forward model: edit dev → promote staging → promote prod.';
    }
    if (result?.propertySync === false) {
      hints.propertySync = 'Property sync skipped — target not yet executable. Run setup({scriptId}) then re-promote to sync properties.';
    }
  }

  if (operation === 'status') {
    hints.workflow = 'Library promote workflow: push → promote to=staging → test → promote to=prod.';
    hints.setup = 'To make dev project executable for property sync: run setup({scriptId}).';
  }

  if (operation === 'setup') {
    hints.next = 'Template wired. Run promote({to: "staging"}) to push files to the staging-source library.';
  }

  return hints;
}

/**
 * Generate error hints for promote/setup failures.
 */
export function generatePromoteErrorHints(
  operation: string,
  errorMessage: string
): Record<string, string> {
  const hints: Record<string, string> = {};
  const msg = errorMessage.toLowerCase();

  if (msg.includes('not authenticated') || msg.includes('auth')) {
    hints.auth = 'Run auth action="login" to authenticate.';
  }

  if (msg.includes('scriptid') || msg.includes('script id')) {
    hints.scriptId = 'Provide scriptId explicitly or point localDir to a directory with .clasp.json.';
  }

  if (msg.includes('missing file') || msg.includes('common-js')) {
    hints.runtime = 'Dev project is missing required CommonJS runtime files. Run push first, or use create to bootstrap the project.';
  }

  if (msg.includes('permission') || msg.includes('403')) {
    hints.permission = 'Check that you have edit access to the GAS project. Re-authenticate if needed: auth action="login".';
  }

  if (operation === 'promote' && msg.includes('to')) {
    hints.to = 'Specify promote target: to="staging" or to="prod".';
  }

  if (Object.keys(hints).length === 0) {
    hints.general = `${operation} failed: ${errorMessage}`;
  }

  return hints;
}
