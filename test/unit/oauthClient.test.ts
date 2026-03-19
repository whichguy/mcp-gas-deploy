/**
 * Regression tests for 3 OAuthClient bug fixes:
 * 1. Fix 1: 413 body-cap + req.destroy() does not resolve bootstrap wait (bodyRejected flag)
 * 2. Fix 2: startLogin() with registeredUri creates exactly one server (no orphaned server)
 * 3. Fix 3: startLogin() with portless redirect_uri throws descriptive error
 *
 * Additional coverage:
 * - loadOAuthConfig: pure async config loader (5 path/shape tests)
 * - waitForBootstrapToken behavioral paths (CORS, 404, wrong nonce, missing token)
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sinon from 'sinon';
import { OAuthClient, loadOAuthConfig, type AuthConfig } from '../../src/auth/oauthClient.js';
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

  it('calls startCallbackServer (not startCallbackServerOnPort) when no registeredUri', async () => {
    const client = new OAuthClient(makeConfig([]), makeSessionManager());
    const startServerStub = sinon.stub(client as any, 'startCallbackServer').resolves(12345);
    const startOnPortStub = sinon.stub(client as any, 'startCallbackServerOnPort').resolves();
    sinon.stub(client as any, 'waitForCallback').resolves({ success: true });

    await client.startLogin();

    assert.equal(startServerStub.callCount, 1);
    assert.equal(startOnPortStub.callCount, 0);
  });
});

// ── Fix 3: portless redirect URI fails with descriptive error ─────────────

describe('OAuthClient — Fix 3: portless redirect URI returns descriptive error', () => {
  afterEach(() => sinon.restore());

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

// ── loadOAuthConfig: pure async config loader ─────────────────────────────

describe('loadOAuthConfig', () => {
  const TEST_BASE = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
  let tmpDir: string;
  let cwdStub: sinon.SinonStub;

  let homeStub: sinon.SinonStub;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'oauth-config-'));
    cwdStub = sinon.stub(process, 'cwd').returns(tmpDir);
    // Also stub homedir so ~/.config/mcp-gas/oauth-config.json is not found
    homeStub = sinon.stub(os, 'homedir').returns(tmpDir);
  });

  afterEach(async () => {
    cwdStub.restore();
    homeStub.restore();
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no config file exists', async () => {
    const result = await loadOAuthConfig();
    assert.equal(result, null);
  });

  it('reads from .mcp-gas/oauth-config.json (path 1)', async () => {
    const mcpGasDir = path.join(tmpDir, '.mcp-gas');
    await fs.mkdir(mcpGasDir, { recursive: true });
    await fs.writeFile(
      path.join(mcpGasDir, 'oauth-config.json'),
      JSON.stringify({
        installed: {
          client_id: 'path1-client-id',
          client_secret: 'path1-secret',
          redirect_uris: ['http://127.0.0.1:58001/callback'],
        },
      })
    );

    const result = await loadOAuthConfig();

    assert.ok(result !== null);
    assert.equal(result.client_id, 'path1-client-id');
    assert.equal(result.client_secret, 'path1-secret');
    assert.deepEqual(result.redirect_uris, ['http://127.0.0.1:58001/callback']);
    assert.ok(Array.isArray(result.scopes) && result.scopes.length > 0, 'scopes must be set to GAS_SCOPES');
  });

  it('reads from oauth-config.json at CWD root (path 2 fallback)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'oauth-config.json'),
      JSON.stringify({
        installed: {
          client_id: 'path2-client-id',
          client_secret: 'path2-secret',
          redirect_uris: ['http://127.0.0.1:58002/callback'],
        },
      })
    );

    const result = await loadOAuthConfig();

    assert.ok(result !== null);
    assert.equal(result.client_id, 'path2-client-id');
    assert.equal(result.client_secret, 'path2-secret');
  });

  it('handles {web: {...}} shape', async () => {
    const mcpGasDir = path.join(tmpDir, '.mcp-gas');
    await fs.mkdir(mcpGasDir, { recursive: true });
    await fs.writeFile(
      path.join(mcpGasDir, 'oauth-config.json'),
      JSON.stringify({
        web: {
          client_id: 'web-client-id',
          client_secret: 'web-secret',
          redirect_uris: ['http://127.0.0.1:58003/callback'],
        },
      })
    );

    const result = await loadOAuthConfig();

    assert.ok(result !== null);
    assert.equal(result.client_id, 'web-client-id');
    assert.equal(result.client_secret, 'web-secret');
  });

  it('defaults redirect_uris to ["http://127.0.0.1"] when missing from config', async () => {
    const mcpGasDir = path.join(tmpDir, '.mcp-gas');
    await fs.mkdir(mcpGasDir, { recursive: true });
    await fs.writeFile(
      path.join(mcpGasDir, 'oauth-config.json'),
      JSON.stringify({
        installed: {
          client_id: 'no-uris-client',
          client_secret: 'no-uris-secret',
        },
      })
    );

    const result = await loadOAuthConfig();

    assert.ok(result !== null);
    assert.deepEqual(result.redirect_uris, ['http://127.0.0.1']);
  });
});

// ── waitForBootstrapToken behavioral paths ────────────────────────────────

describe('OAuthClient — waitForBootstrapToken behavioral paths', () => {
  type PrivateClient = {
    startCallbackServer(): Promise<number>;
    waitForBootstrapToken(n: string, t: number): Promise<{ success: boolean; error?: string }>;
    cleanupServer(): void;
  };

  let client: OAuthClient;
  let port: number;

  beforeEach(async () => {
    client = new OAuthClient(makeConfig(), makeSessionManager());
    port = await (client as unknown as PrivateClient).startCallbackServer();
  });

  afterEach(() => {
    (client as unknown as PrivateClient).cleanupServer?.();
    sinon.restore();
  });

  it('CORS preflight (OPTIONS /token) → 204 with required headers', async () => {
    const nonce = 'cors-test-nonce';
    const bootstrapPromise = (client as unknown as PrivateClient).waitForBootstrapToken(nonce, 2000);

    const res = await fetch(`http://127.0.0.1:${port}/token`, { method: 'OPTIONS' });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://script.google.com');
    assert.equal(res.headers.get('Access-Control-Allow-Private-Network'), 'true');

    // OPTIONS should not resolve the promise
    let earlyResolved = false;
    bootstrapPromise.then(() => { earlyResolved = true; }).catch(() => { earlyResolved = true; });
    await new Promise<void>(r => setTimeout(r, 200));
    assert.equal(earlyResolved, false, 'OPTIONS must not resolve the bootstrap promise');
  });

  it('non-matching route (POST /other) → 404, server continues', async () => {
    const nonce = 'route-test-nonce';
    const bootstrapPromise = (client as unknown as PrivateClient).waitForBootstrapToken(nonce, 2000);

    const res = await fetch(`http://127.0.0.1:${port}/other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, token: 'some-token' }),
    });

    assert.equal(res.status, 404);

    let earlyResolved = false;
    bootstrapPromise.then(() => { earlyResolved = true; }).catch(() => { earlyResolved = true; });
    await new Promise<void>(r => setTimeout(r, 200));
    assert.equal(earlyResolved, false, 'POST /other must not resolve the bootstrap promise');
  });

  it('wrong nonce → 403 with error body, promise does not resolve', async () => {
    const nonce = 'correct-nonce';
    const bootstrapPromise = (client as unknown as PrivateClient).waitForBootstrapToken(nonce, 2000);

    const res = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: 'wrong-nonce', token: 'some-token' }),
    });

    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'Invalid nonce');

    let earlyResolved = false;
    bootstrapPromise.then(() => { earlyResolved = true; }).catch(() => { earlyResolved = true; });
    await new Promise<void>(r => setTimeout(r, 300));
    assert.equal(earlyResolved, false, 'Wrong nonce must not resolve the bootstrap promise');
  });

  it('missing token field → 400 with error body, promise does not resolve', async () => {
    const nonce = 'token-test-nonce';
    const bootstrapPromise = (client as unknown as PrivateClient).waitForBootstrapToken(nonce, 2000);

    const res = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'Missing or invalid token');

    let earlyResolved = false;
    bootstrapPromise.then(() => { earlyResolved = true; }).catch(() => { earlyResolved = true; });
    await new Promise<void>(r => setTimeout(r, 300));
    assert.equal(earlyResolved, false, 'Missing token must not resolve the bootstrap promise');
  });
});
