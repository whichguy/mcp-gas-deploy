/**
 * OAuth Client for mcp_gas_deploy
 *
 * Implements OAuth 2.0 PKCE flow for Google Apps Script API.
 * Forked from mcp_gas GASAuthClient — standalone with no mcp_gas dependencies.
 */

import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PKCEGenerator } from './pkce.js';
import { SessionManager, type TokenInfo, type UserInfo } from './sessionManager.js';

const GAS_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/script.webapp.deploy',
  'https://www.googleapis.com/auth/script.scriptapp',        // scripts.run API execution
  'https://www.googleapis.com/auth/script.external_request',  // scripts.run: manifest declares this scope
  'https://www.googleapis.com/auth/drive', // trashProject (delete) + list/search standalone GAS scripts
  // drive.file is insufficient for deleting Script-API-created projects (appNotAuthorizedToFile)
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export interface AuthConfig {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  scopes: string[];
}

export interface OAuthFlowResult {
  success: boolean;
  user?: UserInfo;
  error?: string;
  authUrl?: string;
}

/**
 * OAuth client for GAS API authentication.
 * Handles PKCE flow with local callback server.
 */
export class OAuthClient {
  private config: AuthConfig;
  private sessionManager: SessionManager;
  private oauth2Client: OAuth2Client;
  private server?: http.Server;
  // codeVerifier and state are ephemeral per-flow PKCE values — OAuthClient must be
  // instantiated fresh per login flow (not a singleton).
  private codeVerifier?: string;
  private state?: string;

  constructor(config: AuthConfig, sessionManager: SessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.oauth2Client = new OAuth2Client({
      clientId: config.client_id,
      clientSecret: config.client_secret,
    });
  }

  /**
   * Start the OAuth login flow.
   * Opens a local callback server, generates PKCE + state, returns auth URL.
   */
  async startLogin(): Promise<OAuthFlowResult> {
    try {
      const pkce = PKCEGenerator.generateChallenge();
      this.codeVerifier = pkce.codeVerifier;
      this.state = crypto.randomUUID();

      // Use the first registered redirect_uri from config (must match GCP Console registration).
      // Parse its port so the local server binds to the same port.
      const registeredUri = this.config.redirect_uris?.[0];
      let port: number;
      let redirectUri: string;
      if (registeredUri) {
        const parsed = new URL(registeredUri);
        port = parsed.port ? parseInt(parsed.port, 10) : 80;
        redirectUri = registeredUri;
      } else {
        port = await this.startCallbackServer();
        redirectUri = `http://127.0.0.1:${port}/callback`;
      }
      await this.startCallbackServerOnPort(port);

      const authUrl = this.oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: this.config.scopes,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        state: this.state,
        redirect_uri: redirectUri,
        prompt: 'consent',
      });

      console.error(`OAuth server listening on port ${port}`);
      console.error(`Authorization URL: ${authUrl}`);

      // Try to open browser
      try {
        const { default: open } = await import('open');
        await open(authUrl);
        console.error('Browser launched for authentication');
      } catch {
        console.error('Could not open browser automatically.');
        console.error('Please open this URL manually:', authUrl);
      }

      // Wait for callback (60s timeout)
      const result = await this.waitForCallback(redirectUri, 60000);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `OAuth flow failed: ${message}` };
    } finally {
      this.cleanupServer();
    }
  }

  /** Start local HTTP server for OAuth callback on a random port */
  private startCallbackServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== 'string') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });
      this.server.on('error', reject);
    });
  }

  /** Start local HTTP server on a specific port (to match registered redirect_uri) */
  private startCallbackServerOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();
      this.server.listen(port, '127.0.0.1', () => resolve());
      this.server.on('error', reject);
    });
  }

  /** Wait for the OAuth callback with timeout */
  private waitForCallback(redirectUri: string, timeoutMs: number): Promise<OAuthFlowResult> {
    return new Promise((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Authentication timed out (60s)' });
        }
      }, timeoutMs);

      this.server!.on('request', async (req, res) => {
        if (resolved || !req.url?.startsWith('/callback')) {
          if (req.url === '/favicon.ico') {
            res.writeHead(404).end();
          } else if (!req.url?.startsWith('/callback')) {
            res.writeHead(404).end('Not found');
          } else {
            // resolved=true, late /callback — send 200 to avoid connection hang
            res.writeHead(200).end();
          }
          return;
        }

        try {
          const url = new URL(req.url, `http://127.0.0.1`);
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (state !== this.state) {
            resolved = true;
            clearTimeout(timeout);
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Invalid State</h1></body></html>');
            resolve({ success: false, error: 'State mismatch — possible CSRF attack' });
            return;
          }

          if (error) {
            resolved = true;
            clearTimeout(timeout);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Failed</h1><p>You can close this tab.</p></body></html>');
            resolve({ success: false, error: `OAuth error: ${error}` });
            return;
          }

          if (!code) {
            resolved = true;
            clearTimeout(timeout);
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Missing Code</h1></body></html>');
            resolve({ success: false, error: 'No authorization code received' });
            return;
          }

          // Exchange code for tokens
          const { tokens } = await this.oauth2Client.getToken({
            code,
            codeVerifier: this.codeVerifier,
            redirect_uri: redirectUri,
          });

          // Fetch user info
          this.oauth2Client.setCredentials(tokens);
          const userInfoResponse = await this.oauth2Client.request<UserInfo>({
            url: 'https://www.googleapis.com/oauth2/v2/userinfo',
          });
          const user = userInfoResponse.data;

          const expiresAt = tokens.expiry_date
            ? tokens.expiry_date - 60000
            : Date.now() + 3600000;

          if (!tokens.access_token) {
            throw new Error('Token exchange succeeded but no access_token was returned');
          }

          const tokenInfo: TokenInfo = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token ?? undefined,
            expires_at: expiresAt,
            scope: tokens.scope || GAS_SCOPES.join(' '),
            token_type: tokens.token_type || 'Bearer',
            client_id: this.config.client_id,
          };

          await this.sessionManager.setAuthSession(tokenInfo, user);

          resolved = true;
          clearTimeout(timeout);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authenticated!</h1><p>Signed in as ${user.email}. You can close this tab.</p></body></html>`);
          resolve({ success: true, user });
        } catch (err: unknown) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Error</h1></body></html>');
            resolve({ success: false, error: `Token exchange failed: ${message}` });
          }
        }
      });
    });
  }

  // Bootstrap flow — token delivered via GAS web app POST (no oauth2Client exchange)
  async startBootstrapFlow(tokenBrokerUrl: string): Promise<OAuthFlowResult> {
    if (this.server) {
      return { success: false, error: 'Auth flow already in progress' };
    }

    try {
      const nonce = crypto.randomBytes(16).toString('hex');

      // Find free port starting at 3456 — loop startCallbackServerOnPort, increment on EADDRINUSE
      let port = 3456;
      while (true) {
        try {
          await this.startCallbackServerOnPort(port);
          break;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            this.cleanupServer();
            port++;
            continue;
          }
          throw err;
        }
      }

      const brokerUrl = `${tokenBrokerUrl}?port=${port}&nonce=${nonce}`;
      console.error(`Bootstrap: local server on port ${port}, opening token broker`);

      try {
        const { default: open } = await import('open');
        await open(brokerUrl);
        console.error('Browser launched for bootstrap auth');
      } catch {
        console.error('Could not open browser automatically. Please visit:', brokerUrl);
      }

      const result = await this.waitForBootstrapToken(nonce, 120000);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Bootstrap flow failed: ${message}` };
    } finally {
      this.cleanupServer();
    }
  }

  /** Wait up to timeoutMs for POST /token with valid nonce */
  private waitForBootstrapToken(expectedNonce: string, timeoutMs: number): Promise<OAuthFlowResult> {
    return new Promise((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({
            success: false,
            error: 'Bootstrap auth timed out (120s). Re-run auth({action:"bootstrap"}) to try again.',
          });
        }
      }, timeoutMs);

      this.server!.on('request', (req, res) => {
        // CORS preflight — required for Private Network Access (HTTPS→localhost)
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': 'https://script.google.com',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Private-Network': 'true',
          });
          res.end();
          return;
        }

        if (req.method !== 'POST' || req.url !== '/token') {
          res.writeHead(404).end('Not found');
          return;
        }

        if (resolved) {
          res.writeHead(200).end();
          return;
        }

        // Read request body
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                token?: string;
                nonce?: string;
              };

              // Nonce validation — rejects CSRF attempts
              if (body.nonce !== expectedNonce) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid nonce' }));
                return;
              }

              if (!body.token) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing token' }));
                return;
              }

              // Fetch userinfo via direct GET — bootstrap receives a raw token, not from oauth2Client.getToken()
              const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${body.token}` },
              });

              if (!userInfoRes.ok) {
                const text = await userInfoRes.text();
                throw new Error(`userinfo fetch failed: ${userInfoRes.status} ${text}`);
              }

              const user = (await userInfoRes.json()) as UserInfo;

              const tokenInfo: TokenInfo = {
                access_token: body.token,
                expires_at: Date.now() + 55 * 60 * 1000,
                scope: GAS_SCOPES.join(' '),
                token_type: 'Bearer',
              };

              await this.sessionManager.setAuthSession(tokenInfo, user);

              resolved = true;
              clearTimeout(timeout);
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': 'https://script.google.com',
              });
              res.end(JSON.stringify({ success: true }));
              resolve({ success: true, user });
            } catch (err: unknown) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                const message = err instanceof Error ? err.message : String(err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: message }));
                resolve({ success: false, error: `Bootstrap token delivery failed: ${message}` });
              }
            }
          })();
        });
        req.on('error', (err: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({ success: false, error: `Request error: ${err.message}` });
          }
        });
      });
    });
  }

  private cleanupServer(): void {
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = undefined;
    }
  }
}

/**
 * Load OAuth config from the standard gas config file.
 * Returns null if not found.
 */
export async function loadOAuthConfig(): Promise<AuthConfig | null> {
  const configPaths = [
    path.join(process.cwd(), '.mcp-gas', 'oauth-config.json'),
    path.join(process.cwd(), 'oauth-config.json'),
    path.join(os.homedir(), '.config', 'mcp-gas', 'oauth-config.json'),
  ];

  for (const p of configPaths) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(content);
      const installed = parsed.installed || parsed.web || parsed.oauth || parsed;
      return {
        client_id: installed.client_id,
        client_secret: installed.client_secret,
        redirect_uris: installed.redirect_uris || ['http://127.0.0.1'],
        scopes: GAS_SCOPES,
      };
    } catch {
      continue;
    }
  }
  return null;
}

