/**
 * Session Authentication Manager for mcp_gas_deploy
 *
 * Filesystem-based token persistence with automatic refresh.
 * Forked from mcp_gas SessionAuthManager — stripped of deployment URL caching
 * and infrastructure verification (mcp_gas-specific concerns).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OAuth2Client } from 'google-auth-library';

const TOKEN_CACHE_DIR = path.join(os.homedir(), '.auth', 'mcp-gas', 'tokens');

export interface TokenInfo {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
  token_type: string;
  client_id?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
  verified_email: boolean;
}

export interface AuthSession {
  sessionId: string;
  tokens: TokenInfo;
  user: UserInfo;
  createdAt: number;
  lastUsed: number;
}

// --- Filesystem helpers ---

async function ensureCacheDir(): Promise<void> {
  try {
    await fs.mkdir(TOKEN_CACHE_DIR, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error('Failed to create token cache directory:', error);
    }
  }
}

function getTokenCachePath(email: string): string {
  const safeEmail = email.replace(/[^a-z0-9@.-]/gi, '_');
  return path.join(TOKEN_CACHE_DIR, `${safeEmail}.json`);
}

async function readTokenCache(email: string): Promise<AuthSession | null> {
  try {
    const content = await fs.readFile(getTokenCachePath(email), 'utf-8');
    const session = JSON.parse(content) as AuthSession;
    if (!session.tokens || !session.user || !session.tokens.expires_at) {
      return null;
    }
    return session;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`Error reading token cache for ${email}:`, error);
    return null;
  }
}

async function writeTokenCache(email: string, session: AuthSession): Promise<void> {
  await ensureCacheDir();
  const cachePath = getTokenCachePath(email);
  const tempPath = `${cachePath}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(session, null, 2), { mode: 0o600 });
    await fs.rename(tempPath, cachePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

async function deleteTokenCache(email: string): Promise<void> {
  try {
    await fs.unlink(getTokenCachePath(email));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error deleting token cache for ${email}:`, error);
    }
  }
}

async function listCachedEmails(): Promise<string[]> {
  try {
    await ensureCacheDir();
    const files = await fs.readdir(TOKEN_CACHE_DIR);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

// --- Session Manager ---

export class SessionManager {
  private sessionId: string;
  private sessionIdConfirmed = false;
  private clientId: string;

  // Refresh-in-flight guard: prevents concurrent double-refresh race
  private refreshPromise: Promise<TokenInfo | null> | null = null;

  constructor(sessionId?: string, clientId?: string) {
    this.sessionId = sessionId ?? randomUUID();
    this.sessionIdConfirmed = false;
    this.clientId = clientId ?? '';
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Refresh access token using refresh_token (with deduplication guard) */
  private async refreshAccessToken(session: AuthSession): Promise<TokenInfo | null> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this._doRefresh(session).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async _doRefresh(session: AuthSession): Promise<TokenInfo | null> {
    if (!session.tokens.refresh_token) return null;

    try {
      console.error(`Refreshing access token for ${session.user.email}...`);
      const oauth2Client = new OAuth2Client(session.tokens.client_id ?? this.clientId);
      oauth2Client.setCredentials({ refresh_token: session.tokens.refresh_token });
      const { credentials } = await oauth2Client.refreshAccessToken();

      const expiresAt = credentials.expiry_date
        ? credentials.expiry_date - 60000
        : Date.now() + 3600000;

      return {
        access_token: credentials.access_token!,
        refresh_token: credentials.refresh_token || session.tokens.refresh_token,
        expires_at: expiresAt,
        scope: credentials.scope || session.tokens.scope,
        token_type: credentials.token_type || 'Bearer',
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Token refresh failed for ${session.user.email}: ${message}`);
      await deleteTokenCache(session.user.email);
      return null;
    }
  }

  /** Find an existing valid session from filesystem (auto-refreshes expired tokens) */
  private async findExistingValidSession(): Promise<string | null> {
    const emails = await listCachedEmails();
    for (const email of emails) {
      const session = await readTokenCache(email);
      if (!session) continue;

      const bufferMs = 5 * 60 * 1000;
      const isValid = Date.now() < (session.tokens.expires_at - bufferMs);

      if (isValid) {
        session.lastUsed = Date.now();
        await writeTokenCache(email, session);
        return session.sessionId;
      }

      if (session.tokens.refresh_token) {
        const newTokens = await this.refreshAccessToken(session);
        if (newTokens) {
          session.tokens = newTokens;
          session.lastUsed = Date.now();
          await writeTokenCache(email, session);
          return session.sessionId;
        }
      }
    }
    return null;
  }

  private async ensureSessionIdConfirmed(): Promise<void> {
    if (this.sessionIdConfirmed) return;
    const existing = await this.findExistingValidSession();
    if (existing) this.sessionId = existing;
    this.sessionIdConfirmed = true;
  }

  private async findSessionById(sessionId: string): Promise<AuthSession | null> {
    const emails = await listCachedEmails();
    for (const email of emails) {
      const session = await readTokenCache(email);
      if (session?.sessionId === sessionId) return session;
    }
    return null;
  }

  async setAuthSession(tokens: TokenInfo, user: UserInfo): Promise<void> {
    const session: AuthSession = {
      sessionId: this.sessionId,
      tokens,
      user,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    await writeTokenCache(user.email, session);
  }

  async getAuthSession(): Promise<AuthSession | null> {
    await this.ensureSessionIdConfirmed();
    const session = await this.findSessionById(this.sessionId);
    if (session) {
      session.lastUsed = Date.now();
      await writeTokenCache(session.user.email, session);
    }
    return session;
  }

  async isAuthenticated(): Promise<boolean> {
    await this.ensureSessionIdConfirmed();
    const session = await this.findSessionById(this.sessionId);
    if (!session) return false;
    const bufferMs = 5 * 60 * 1000;
    return Date.now() < (session.tokens.expires_at - bufferMs);
  }

  async getValidToken(): Promise<string | null> {
    await this.ensureSessionIdConfirmed();
    const session = await this.findSessionById(this.sessionId);
    if (!session) return null;

    const bufferMs = 5 * 60 * 1000;
    if (Date.now() >= session.tokens.expires_at - bufferMs) {
      if (session.tokens.refresh_token) {
        const newTokens = await this.refreshAccessToken(session);
        if (newTokens) {
          session.tokens = newTokens;
          await writeTokenCache(session.user.email, session);
          return session.tokens.access_token;
        }
      }
      await deleteTokenCache(session.user.email);
      return null;
    }
    return session.tokens.access_token;
  }

  async getUserInfo(): Promise<UserInfo | null> {
    const session = await this.findSessionById(this.sessionId);
    return session?.user ?? null;
  }

  async clearAuth(): Promise<void> {
    await this.ensureSessionIdConfirmed();
    const session = await this.findSessionById(this.sessionId);
    if (session) {
      await deleteTokenCache(session.user.email);
    }
  }

  async getAuthStatus(): Promise<{
    sessionId: string;
    authenticated: boolean;
    user?: UserInfo;
    tokenValid: boolean;
    expiresIn?: number;
  }> {
    await this.ensureSessionIdConfirmed();
    const session = await this.findSessionById(this.sessionId);
    if (!session) {
      return { sessionId: this.sessionId, authenticated: false, tokenValid: false };
    }
    const bufferMs = 5 * 60 * 1000;
    const tokenValid = Date.now() < (session.tokens.expires_at - bufferMs);
    const expiresIn = tokenValid
      ? Math.max(0, Math.floor((session.tokens.expires_at - Date.now()) / 1000))
      : 0;
    return {
      sessionId: this.sessionId,
      authenticated: true,
      user: session.user,
      tokenValid,
      expiresIn,
    };
  }
}
