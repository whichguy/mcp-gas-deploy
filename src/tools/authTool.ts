/**
 * Auth Tool for mcp-gas-deploy
 *
 * Handles login, logout, and status actions for Google OAuth.
 */

import { OAuthClient } from '../auth/oauthClient.js';
import { SessionManager } from '../auth/sessionManager.js';

export interface AuthToolParams {
  action: 'login' | 'logout' | 'status';
}

export interface AuthToolResult {
  success: boolean;
  action: string;
  message: string;
  user?: {
    email: string;
    name: string;
  };
  hints?: Record<string, string>;
  error?: string;
}

/**
 * MCP tool definition for the auth tool.
 */
export const AUTH_TOOL_DEFINITION = {
  name: 'auth',
  description: 'Manage Google OAuth authentication. Use action="login" to authenticate, "logout" to clear credentials, "status" to check current auth state.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['login', 'logout', 'status'],
        description: 'Authentication action to perform',
      },
    },
    required: ['action'],
  },
};

/**
 * Handle an auth tool invocation.
 */
export async function handleAuthTool(
  params: AuthToolParams,
  oauthClient: OAuthClient,
  sessionManager: SessionManager
): Promise<AuthToolResult> {
  const { action } = params;

  switch (action) {
    case 'login': {
      const result = await oauthClient.startLogin();

      if (result.success && result.user) {
        return {
          success: true,
          action: 'login',
          message: `Authenticated as ${result.user.email}`,
          user: {
            email: result.user.email,
            name: result.user.name,
          },
          hints: {
            next: 'You are now authenticated. You can use deploy tools.',
            cache: 'Tokens are cached to disk and will auto-refresh.',
          },
        };
      }

      return {
        success: false,
        action: 'login',
        message: 'Authentication failed',
        error: result.error,
        hints: {
          fix: 'Ensure oauth-config.json is present in the working directory or ~/.config/mcp-gas/',
          scope: 'Check that the OAuth client has the required scopes enabled.',
        },
      };
    }

    case 'logout': {
      await sessionManager.clearAuth();
      return {
        success: true,
        action: 'logout',
        message: 'Logged out. Local credentials cleared.',
        hints: { next: 'Run auth with action="login" to authenticate again.' },
      };
    }

    case 'status': {
      const status = await sessionManager.getAuthStatus();

      if (!status.authenticated) {
        return {
          success: true,
          action: 'status',
          message: 'Not authenticated',
          hints: { next: 'Run auth with action="login" to authenticate.' },
        };
      }

      const expiresMsg = status.expiresIn
        ? `Token expires in ${Math.floor(status.expiresIn / 60)} minutes`
        : 'Token status unknown';

      return {
        success: true,
        action: 'status',
        message: status.tokenValid
          ? `Authenticated as ${status.user?.email}. ${expiresMsg}.`
          : `Session exists but token is expired. Re-login required.`,
        user: status.user
          ? { email: status.user.email, name: status.user.name }
          : undefined,
        hints: status.tokenValid
          ? { next: 'Token is valid. Deploy tools are available.' }
          : { fix: 'Run auth with action="login" to refresh your session.' },
      };
    }
  }
}
