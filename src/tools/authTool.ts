/**
 * Auth Tool for mcp-gas-deploy
 *
 * Handles login, logout, and status actions for Google OAuth.
 */

import { OAuthClient, loadOAuthConfig } from '../auth/oauthClient.js';
import { SessionManager } from '../auth/sessionManager.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';
import { loadBootstrapConfig, saveBootstrapConfig } from '../auth/bootstrapConfig.js';

export interface AuthToolParams {
  action: 'login' | 'logout' | 'status' | 'bootstrap';
  tokenBrokerUrl?: string;
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
  description: '[AUTH] Manage Google OAuth — login, logout, or check status. WHEN: first use, scope errors, or checking auth state. AVOID: unnecessary re-login (tokens persist). Example: auth({action: "status"})',
  annotations: {
    title: 'OAuth Authentication',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['login', 'logout', 'status', 'bootstrap'],
        description: 'Authentication action to perform',
      },
      tokenBrokerUrl: {
        type: 'string',
        description: 'Token broker web app exec URL (https://script.google.com/macros/s/{id}/exec). Required on first bootstrap call; saved to .mcp-gas/bootstrap-config.json for subsequent calls.',
      },
    },
    required: ['action'],
    additionalProperties: false,
    llmGuidance: {
      workflow: 'Check status first. Login only if not authenticated or token expired. Logout only when switching accounts.',
      scopeErrors: 'If a tool returns a scope error, re-login to refresh OAuth scopes. Tokens auto-refresh otherwise.',
      tokenPersistence: 'Tokens are cached to disk (.mcp-gas/tokens/ in the project directory). They survive restarts and auto-refresh.',
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      action: { type: 'string' },
      message: { type: 'string' },
      user: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          name: { type: 'string' },
        },
      },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success', 'action', 'message'],
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
  const { action, tokenBrokerUrl } = params;

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

      const loginOauthConfig = await loadOAuthConfig();
      return {
        success: false,
        action: 'login',
        message: 'Authentication failed',
        error: result.error,
        hints: {
          fix: 'Ensure oauth-config.json is present in .mcp-gas/ in your project directory.',
          scope: 'Check that the OAuth client has the required scopes enabled.',
          ...(!loginOauthConfig ? { oauthConfig: 'No oauth-config.json found — download from GCP Console > APIs & Services > Credentials > your Desktop App client.' } : {}),
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

    case 'bootstrap': {
      if (tokenBrokerUrl) {
        await saveBootstrapConfig(process.cwd(), tokenBrokerUrl);
      }
      const brokerUrl = tokenBrokerUrl ?? (await loadBootstrapConfig())?.tokenBrokerUrl;
      if (!brokerUrl) {
        return {
          success: false,
          action: 'bootstrap',
          message: 'No token broker URL found.',
          error: 'No token broker URL configured.',
          hints: {
            fix: 'Deploy the token broker first: setup({operation: "deploy-token-broker"}). Then re-run auth({action: "bootstrap", tokenBrokerUrl: "<exec-url>"}).',
          },
        };
      }

      const bootstrapResult = await oauthClient.startBootstrapFlow(brokerUrl);
      if (bootstrapResult.success && bootstrapResult.user) {
        return {
          success: true,
          action: 'bootstrap',
          message: `Authenticated as ${bootstrapResult.user.email} via token broker`,
          user: { email: bootstrapResult.user.email, name: bootstrapResult.user.name },
          hints: {
            next: 'You are now authenticated. Token expires in ~55 minutes. Run auth({action:"bootstrap"}) to re-authenticate when expired.',
          },
        };
      }
      return {
        success: false,
        action: 'bootstrap',
        message: 'Bootstrap authentication failed',
        error: bootstrapResult.error,
        hints: {
          fix: 'Re-run auth({action:"bootstrap"}) to try again. If the issue persists, re-run setup({operation:"deploy-token-broker"}) to redeploy the broker.',
        },
      };
    }

    case 'status': {
      const status = await sessionManager.getAuthStatus();

      const statusOauthConfig = await loadOAuthConfig();
      const setupHints: Record<string, string> = {};
      if (!statusOauthConfig) {
        setupHints.oauthConfig = 'No oauth-config.json found in .mcp-gas/ — run setup({operation: "init"}) first.';
      }

      if (!status.authenticated) {
        return {
          success: true,
          action: 'status',
          message: 'Not authenticated',
          hints: {
            next: 'Run auth with action="login" to authenticate.',
            ...setupHints,
          },
        };
      }

      const expiresMsg = status.expiresIn
        ? `Token expires in ${Math.floor(status.expiresIn / 60)} minutes`
        : 'Token status unknown';

      if (!status.tokenValid) {
        const bootstrapConfig = await loadBootstrapConfig();
        const expiredHint = bootstrapConfig
          ? 'Token expired. Run auth({action: "bootstrap"}) to re-authenticate via token broker.'
          : 'Run auth with action="login" to refresh your session.';
        return {
          success: true,
          action: 'status',
          message: 'Session exists but token is expired. Re-authentication required.',
          user: status.user ? { email: status.user.email, name: status.user.name } : undefined,
          hints: { fix: expiredHint, ...setupHints },
        };
      }

      return {
        success: true,
        action: 'status',
        message: `Authenticated as ${status.user?.email}. ${expiresMsg}.`,
        user: status.user
          ? { email: status.user.email, name: status.user.name }
          : undefined,
        hints: { next: 'Token is valid. Deploy tools are available.' },
      };
    }
  }
}
