/**
 * Auth E2E tests for mcp-gas-deploy
 *
 * Tests cold-start auth (start action), status, and logout end-to-end.
 *
 * Cold-start behavior: before() detects no credentials and calls auth({action:"start"})
 * which tries bootstrap → login fallback. Browser interaction may be required on first run.
 *
 * Prerequisites:
 *   - oauth-config.json or bootstrap-config.json in .mcp-gas/ (for cold-start path)
 *
 * Run: npm run test:e2e:auth
 *
 * WARNING: A3 (logout) is mutating but safe — before() backs up token files and
 * after() always restores them, even if a test crashes.
 */

import { describe, it, before, after } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { handleAuthTool } from '../../src/tools/authTool.js';
import { OAuthClient } from '../../src/auth/oauthClient.js';
import { SessionManager } from '../../src/auth/sessionManager.js';

const TOKEN_CACHE_DIR = path.join(process.cwd(), '.mcp-gas', 'tokens');
const tokenBackupDir = path.join(os.tmpdir(), `mcp-gas-auth-e2e-backup-${Date.now()}`);

// status and logout do not invoke the OAuth client directly.
// start builds its own OAuthClient from loadOAuthConfigFromJson() internally — the passed
// oauthClient is not used for the PKCE login path. Minimal config is sufficient here.
const stubOAuthClient = new OAuthClient({ client_id: '', redirect_uris: [], scopes: [] });

describe('Auth E2E', function () {
  this.timeout(30_000);

  before(async function () {
    this.timeout(120_000); // allow browser interaction time
    const sm = new SessionManager();

    // If already authenticated, just backup tokens and proceed
    const existingToken = await sm.getValidToken();
    if (existingToken) {
      await fs.cp(TOKEN_CACHE_DIR, tokenBackupDir, { recursive: true });
      return;
    }

    // start: bootstrap if broker configured, else login with bundled UWP config
    // Opens browser automatically — user completes OAuth consent, then tests run
    const result = await handleAuthTool({ action: 'start' }, stubOAuthClient, sm);
    if (!result.success) return this.skip(); // user cancelled or flow timed out

    await fs.cp(TOKEN_CACHE_DIR, tokenBackupDir, { recursive: true });
  });

  after(async function () {
    // Always restore credentials — even if a test crashed
    try {
      await fs.cp(tokenBackupDir, TOKEN_CACHE_DIR, { recursive: true, force: true });
    } catch { /* ignore if backup dir doesn't exist (suite was skipped) */ }
    await fs.rm(tokenBackupDir, { recursive: true, force: true }).catch(() => {});
  });

  it('A1: status → authenticated with user email and name', async function () {
    const sm = new SessionManager();
    const result = await handleAuthTool({ action: 'status' }, stubOAuthClient, sm);

    assert.strictEqual(result.success, true);
    assert.ok(
      result.message.includes('Authenticated'),
      `Expected 'Authenticated' in message, got: ${result.message}`
    );
    assert.ok(result.user?.email, 'Expected non-empty user.email');
    assert.ok(result.user?.name, 'Expected non-empty user.name');
  });

  it('A2: status → tokenValid=true, expiresIn > 0', async function () {
    const sm = new SessionManager();
    const status = await sm.getAuthStatus();

    assert.strictEqual(status.authenticated, true, 'Expected authenticated === true');
    assert.strictEqual(status.tokenValid, true, 'Expected tokenValid === true');
    assert.ok((status.expiresIn ?? 0) > 0, 'Expected expiresIn > 0');
  });

  it('A3: logout clears credentials; restore works', async function () {
    // Step 1: Logout — deletes token file from disk
    const sm1 = new SessionManager();
    const logoutResult = await handleAuthTool({ action: 'logout' }, stubOAuthClient, sm1);
    assert.strictEqual(logoutResult.success, true, `Logout failed: ${logoutResult.error}`);

    // Step 2: Fresh SessionManager (avoids sessionIdConfirmed cache) — verify not authenticated
    const sm2 = new SessionManager();
    const statusAfterLogout = await handleAuthTool({ action: 'status' }, stubOAuthClient, sm2);
    assert.ok(
      statusAfterLogout.message.includes('Not authenticated'),
      `Expected 'Not authenticated' after logout, got: ${statusAfterLogout.message}`
    );

    // Step 3: Restore token files
    await fs.cp(tokenBackupDir, TOKEN_CACHE_DIR, { recursive: true, force: true });

    // Step 4: Fresh SessionManager — verify credentials are restored
    const sm3 = new SessionManager();
    const statusAfterRestore = await handleAuthTool({ action: 'status' }, stubOAuthClient, sm3);
    assert.ok(
      statusAfterRestore.message.includes('Authenticated'),
      `Expected 'Authenticated' after restore, got: ${statusAfterRestore.message}`
    );
  });
});
