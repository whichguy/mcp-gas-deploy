/**
 * Regression tests for 3 OAuthClient bug fixes:
 * 1. Fix 1: 413 body-cap + req.destroy() does not resolve bootstrap wait (bodyRejected flag)
 * 2. Fix 2: startLogin() with registeredUri creates exactly one server (no orphaned server)
 * 3. Fix 3: startLogin() with portless redirect_uri throws descriptive error
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { OAuthClient, type AuthConfig } from '../../src/auth/oauthClient.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

function makeSessionManager(): SessionManager {
  return {
    setAuthSession: sinon.stub().resolves(),
    getValidToken: sinon.stub().resolves('test-token'),
    getAuthStatus: sinon.stub().resolves({ sessionId: '', authenticated: false, tokenValid: false }),
  } as unknown as SessionManager;
}

function makeConfig(redirectUris: string[] = []): AuthConfig {
  return { client_id: 'test-client-id', redirect_uris: redirectUris, scopes: [] };
}

// ── Fix 1: 413 body-cap does not terminate bootstrap wait ─────────────────

describe('OAuthClient — Fix 1: 413 does not resolve bootstrap wait', () => {
  let client: OAuthClient;

  afterEach(() => {
    (client as unknown as { cleanupServer(): void }).cleanupServer?.();
    sinon.restore();
  });

  it('413 + ECONNRESET from req.destroy does not call resolve({ success: false })', async () => {
    client = new OAuthClient(makeConfig(), makeSessionManager());

    // Start server on OS-assigned random port
    const port = await (client as unknown as { startCallbackServer(): Promise<number> }).startCallbackServer();

    const nonce = 'fix1-test-nonce';
    const bootstrapPromise: Promise<{ success: boolean; error?: string }> =
      (client as unknown as {
        waitForBootstrapToken(n: string, t: number): Promise<{ success: boolean; error?: string }>;
      }).waitForBootstrapToken(nonce, 1500);

    // Send oversized body (> 64 KB cap)
    const oversizedBody = JSON.stringify({ nonce, token: 'x'.repeat(70_000) });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversizedBody,
      });
      assert.equal(r.status, 413, 'server should respond 413 for oversized body');
    } catch {
      // Connection reset by server after writing 413 — valid in some Node versions
    }

    // Allow ECONNRESET time to propagate — if the bug were present it would resolve now
    let earlyResolved = false;
    bootstrapPromise.then(() => { earlyResolved = true; }).catch(() => { earlyResolved = true; });
    await new Promise<void>(r => setTimeout(r, 400));

    assert.equal(
      earlyResolved, false,
      'bootstrap promise must NOT resolve early — bodyRejected flag must suppress ECONNRESET resolution'
    );
  });
});

// ── Fix 2: startLogin() with registeredUri creates one server ─────────────

describe('OAuthClient — Fix 2: startLogin() with registeredUri creates one server', () => {
  afterEach(() => sinon.restore());

  it('calls startCallbackServerOnPort once and never startCallbackServer when registeredUri has port', async () => {
    const client = new OAuthClient(makeConfig(['http://127.0.0.1:58002/callback']), makeSessionManager());

    const startOnPortStub = sinon.stub(
      client as unknown as { startCallbackServerOnPort(p: number): Promise<void> },
      'startCallbackServerOnPort'
    ).resolves();
    const startServerStub = sinon.stub(
      client as unknown as { startCallbackServer(): Promise<number> },
      'startCallbackServer'
    ).resolves(12345);
    sinon.stub(
      client as unknown as { waitForCallback(u: string, t: number): Promise<{ success: boolean }> },
      'waitForCallback'
    ).resolves({ success: true });

    await client.startLogin();

    assert.equal(startOnPortStub.callCount, 1, 'startCallbackServerOnPort must be called exactly once');
    assert.equal(startOnPortStub.firstCall.args[0], 58002, 'must bind to port parsed from registeredUri');
    assert.equal(startServerStub.callCount, 0, 'startCallbackServer must NOT be called when registeredUri is present');
  });
});

// ── Fix 3: portless redirect URI fails with descriptive error ─────────────

describe('OAuthClient — Fix 3: portless redirect URI returns descriptive error', () => {
  it('returns error containing "has no port" and the URI', async () => {
    const portlessUri = 'http://127.0.0.1/callback';
    const client = new OAuthClient(makeConfig([portlessUri]), makeSessionManager());

    const result = await client.startLogin();

    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('has no port'),
      `error must include "has no port", got: ${result.error}`
    );
    assert.ok(
      result.error?.includes(portlessUri),
      `error must include the URI, got: ${result.error}`
    );
  });
});
