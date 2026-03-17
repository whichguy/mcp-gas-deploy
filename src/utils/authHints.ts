import type { SessionManager } from '../auth/sessionManager.js';

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
