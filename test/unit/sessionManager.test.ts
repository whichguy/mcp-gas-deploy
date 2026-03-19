/**
 * Unit tests for SessionManager.getValidToken()
 *
 * Tests token validity, expired-token handling (no refresh_token / with refresh_token),
 * and concurrent refresh deduplication via the refreshPromise guard.
 * Uses sinon stubs on fs.promises (singleton object) to intercept filesystem calls.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { SessionManager } from '../../src/auth/sessionManager.js';
import type { AuthSession } from '../../src/auth/sessionManager.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAuthSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    sessionId: 'sess-123',
    tokens: {
      access_token: 'valid-token',
      expires_at: Date.now() + 30 * 60 * 1000, // 30 minutes from now
      scope: 'https://www.googleapis.com/auth/drive',
      token_type: 'Bearer',
    },
    user: { id: '1', email: 'test@example.com', name: 'Test', verified_email: true },
    createdAt: Date.now(),
    lastUsed: Date.now(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SessionManager.getValidToken()', () => {
  let readdirStub: sinon.SinonStub;
  let readFileStub: sinon.SinonStub;
  let writeFileStub: sinon.SinonStub;
  let renameStub: sinon.SinonStub;
  let unlinkStub: sinon.SinonStub;
  let mkdirStub: sinon.SinonStub;
  let sm: SessionManager;

  beforeEach(() => {
    readdirStub = sinon.stub(fs, 'readdir');
    readFileStub = sinon.stub(fs, 'readFile');
    writeFileStub = sinon.stub(fs, 'writeFile').resolves();
    renameStub = sinon.stub(fs, 'rename').resolves();
    unlinkStub = sinon.stub(fs, 'unlink').resolves();
    mkdirStub = sinon.stub(fs, 'mkdir').resolves();
    // Construct with the sessionId matching the stubbed session
    sm = new SessionManager('sess-123');
  });

  afterEach(() => sinon.restore());

  function stubSessionFile(session: AuthSession): void {
    readdirStub.resolves(['test@example.com.json']);
    readFileStub.resolves(JSON.stringify(session));
  }

  it('returns access_token when token is valid', async () => {
    const session = makeAuthSession(); // valid, expires 30min from now
    stubSessionFile(session);

    const token = await sm.getValidToken();

    assert.equal(token, 'valid-token');
  });

  it('returns null when token expired and no refresh_token (bootstrap token case)', async () => {
    const session = makeAuthSession({
      tokens: {
        access_token: 'valid-token',
        expires_at: Date.now() - 1000, // already expired
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer',
        // no refresh_token
      },
    });
    stubSessionFile(session);

    const token = await sm.getValidToken();

    assert.equal(token, null);
    assert.ok(unlinkStub.called, 'expired token with no refresh_token should delete the cache file');
  });

  it('auto-refreshes and returns new token when expired with refresh_token', async () => {
    const session = makeAuthSession({
      tokens: {
        access_token: 'valid-token',
        expires_at: Date.now() - 1000, // already expired
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer',
        refresh_token: 'rtoken',
      },
    });
    stubSessionFile(session);

    sinon.stub(OAuth2Client.prototype, 'refreshAccessToken').resolves({
      credentials: {
        access_token: 'new-token',
        expiry_date: Date.now() + 3600000,
      },
      res: null,
    } as Awaited<ReturnType<typeof OAuth2Client.prototype.refreshAccessToken>>);

    const token = await sm.getValidToken();

    assert.equal(token, 'new-token');
  });

  it('concurrent calls use single refresh promise (deduplication guard)', async () => {
    // Phase 1: prime sessionIdConfirmed=true with a valid session so that
    // subsequent calls skip findExistingValidSession entirely.
    const validSession = makeAuthSession();
    readdirStub.resolves(['test@example.com.json']);
    readFileStub.resolves(JSON.stringify(validSession));
    await sm.getValidToken(); // sessionIdConfirmed is now true

    // Phase 2: switch stub to return an expired session with refresh_token
    const expiredSession = makeAuthSession({
      tokens: {
        access_token: 'valid-token',
        expires_at: Date.now() - 1000,
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer',
        refresh_token: 'rtoken',
      },
    });
    readFileStub.resolves(JSON.stringify(expiredSession));

    const refreshStub = sinon.stub(OAuth2Client.prototype, 'refreshAccessToken').resolves({
      credentials: {
        access_token: 'new-token',
        expiry_date: Date.now() + 3600000,
      },
      res: null,
    } as Awaited<ReturnType<typeof OAuth2Client.prototype.refreshAccessToken>>);

    // Both concurrent calls share the same SessionManager instance — the
    // refreshPromise guard ensures _doRefresh is started exactly once.
    await Promise.all([sm.getValidToken(), sm.getValidToken()]);

    assert.equal(refreshStub.callCount, 1, 'refreshAccessToken should be called once (deduplication guard)');
  });

  it('returns null when refresh fails', async () => {
    const session = makeAuthSession({
      tokens: {
        access_token: 'valid-token',
        expires_at: Date.now() - 1000, // already expired
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer',
        refresh_token: 'rtoken',
      },
    });
    stubSessionFile(session);

    sinon.stub(OAuth2Client.prototype, 'refreshAccessToken').rejects(new Error('invalid_grant'));

    const token = await sm.getValidToken();

    assert.equal(token, null);
  });
});
