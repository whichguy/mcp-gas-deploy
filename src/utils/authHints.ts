import type { SessionManager } from '../auth/sessionManager.js';
import { loadOAuthConfig, type AuthConfig } from '../auth/oauthClient.js';
import { getRootConfig } from '../config/deployConfig.js';

/**
 * Build a contextual auth-failure hint from live session state.
 * Always returns a non-empty string — never throws.
 */
export async function getAuthHint(sessionManager: SessionManager): Promise<string> {
  try {
    const status = await sessionManager.getAuthStatus();
    if (status.authenticated && !status.tokenValid) {
      const email = status.user?.email;
      const user = email ? ` for ${email}` : '';
      return `Token expired${user}. Run auth action="login" to re-authenticate.`;
    }
  } catch { /* fall through to default */ }
  return 'Not authenticated. Run auth action="login" first.';
}

/**
 * Returns auth hint string plus setup context hints.
 * localDir is optional — if provided, also checks gas-deploy.json for gcpProjectNumber.
 * _configLoader is for testing only — defaults to loadOAuthConfig.
 */
export async function getAuthHintWithSetup(
  sessionManager: SessionManager,
  localDir?: string,
  _configLoader: () => Promise<AuthConfig | null> = loadOAuthConfig
): Promise<{ authHint: string; setupHints: Record<string, string> }> {
  const authHint = await getAuthHint(sessionManager);
  const setupHints: Record<string, string> = {};

  const oauthConfig = await _configLoader();
  if (!oauthConfig) {
    setupHints.oauthConfig = 'No oauth-config.json found in .mcp-gas/ or fallback locations. Run setup({operation: "init"}) first.';
  }

  if (localDir) {
    try {
      const rootConfig = await getRootConfig(localDir);
      if (!rootConfig.gcpProjectNumber) {
        setupHints.gcpProjectNumber = 'No gcpProjectNumber configured. Run setup({operation: "init", gcpProjectNumber: "<number>"}).';
      }
    } catch {
      // Non-fatal — localDir may not have gas-deploy.json yet
    }
  }

  return { authHint, setupHints };
}
