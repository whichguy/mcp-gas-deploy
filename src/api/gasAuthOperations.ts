/**
 * Authentication Operations for mcp_gas_deploy
 *
 * Provides authenticated Google API clients for Apps Script operations.
 * Standalone — no mcp_gas dependencies.
 */

import { google } from 'googleapis';
import { createHash } from 'node:crypto';
import { SessionManager } from '../auth/sessionManager.js';

/**
 * Result of an authenticated API call
 */
export interface ApiCallResult<T> {
  data: T;
}

/**
 * Manages Google API client initialization and authenticated calls.
 */
export class GASAuthOperations {
  private sessionManager: SessionManager;

  // Cache initialized clients to avoid re-creating per call
  private clientCache = new Map<string, {
    scriptApi: ReturnType<typeof google.script>;
    expires: number;
  }>();
  private readonly CLIENT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Retrieve a valid access token from the session manager.
   * Throws if no valid token is available.
   */
  async getAccessToken(): Promise<string> {
    const token = await this.sessionManager.getValidToken();
    if (!token) {
      throw new Error('Not authenticated. Run the auth tool with action="login" first.');
    }
    return token;
  }

  /**
   * Return an authenticated Apps Script API client.
   * Uses token caching to avoid re-initializing on every call.
   */
  async getScriptApi(): Promise<ReturnType<typeof google.script>> {
    const token = await this.getAccessToken();
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const cached = this.clientCache.get(cacheKey);

    if (cached && Date.now() < cached.expires) {
      return cached.scriptApi;
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });

    // Set response timeout on the underlying HTTP client
    const scriptApi = google.script({
      version: 'v1',
      auth,
      timeout: 30000,
    });

    this.clientCache.set(cacheKey, {
      scriptApi,
      expires: Date.now() + this.CLIENT_CACHE_TTL,
    });

    return scriptApi;
  }

  /**
   * Return an authenticated Drive API client.
   * Creates a new client per call (Drive calls are infrequent — no cache needed).
   */
  async getDriveApi(): Promise<ReturnType<typeof google.drive>> {
    const token = await this.getAccessToken();
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });
    return google.drive({ version: 'v3', auth, timeout: 30000 });
  }

  /**
   * Make an authenticated Drive API call with error handling.
   */
  async makeDriveRequest<T>(apiCall: (driveApi: ReturnType<typeof google.drive>) => Promise<T>): Promise<T> {
    const driveApi = await this.getDriveApi();
    try {
      return await apiCall(driveApi);
    } catch (error: unknown) {
      throw this.wrapError(error);
    }
  }

  /**
   * Make an authenticated API call with error handling.
   * On 401, attempts one token refresh then retries.
   */
  async makeAuthenticatedRequest<T>(apiCall: (scriptApi: ReturnType<typeof google.script>) => Promise<T>): Promise<T> {
    // Capture old token before the call so we can evict its cache entry on 401
    const oldToken = await this.sessionManager.getValidToken();
    let scriptApi = await this.getScriptApi();

    try {
      return await apiCall(scriptApi);
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number }; status?: number })
        ?.response?.status ??
        (error as { status?: number })?.status;

      if (status === 401) {
        // Evict stale cache entry (keyed on OLD token) and retry once with a fresh token
        if (oldToken) {
          const cacheKey = createHash('sha256').update(oldToken).digest('hex');
          this.clientCache.delete(cacheKey);
        }

        try {
          scriptApi = await this.getScriptApi();
          return await apiCall(scriptApi);
        } catch (retryError: unknown) {
          throw this.wrapError(retryError);
        }
      }

      throw this.wrapError(error);
    }
  }

  /**
   * Normalize an unknown API error into a standard Error.
   */
  private wrapError(error: unknown): Error {
    if (error instanceof Error) return error;

    // Extract message from googleapis error shape
    const apiError = error as {
      response?: { data?: { error?: { message?: string }; message?: string }; statusText?: string };
      message?: string;
    };

    const message =
      apiError?.response?.data?.error?.message ??
      apiError?.response?.data?.message ??
      apiError?.response?.statusText ??
      apiError?.message ??
      'Unknown API error';

    return new Error(`Apps Script API error: ${message}`);
  }
}
