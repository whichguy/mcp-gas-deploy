/**
 * Unit tests for execHelper — internal GAS exec wrapper.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { execInternal, getConfigValue, setConfigValue } from '../../src/utils/execHelper.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

const SCRIPT_ID = 'abcdefghij1234567890';
const TOKEN = 'test-token-abc';
const HEAD_URL = 'https://script.google.com/macros/s/fakeId/dev';

function makeSessionManager(token: string | null = TOKEN): SessionManager {
  return {
    getValidToken: sinon.stub().resolves(token),
  } as unknown as SessionManager;
}

describe('execInternal', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns success from scripts.run path when available', async () => {
    // scripts.run returns 200 with success result
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({
        done: true,
        response: {
          '@type': 'type.googleapis.com/google.apps.script.v1.ExecutionResponse',
          result: { success: true, result: 42, error: null },
        },
      }),
    } as Response);

    const sessionMgr = makeSessionManager();
    const result = await execInternal(SCRIPT_ID, 'return 42', sessionMgr);
    assert.equal(result.success, true);
    assert.equal(result.result, 42);
  });

  it('falls back to web app on scripts.run 404', async () => {
    // First call (scripts.run) → 404
    fetchStub.onFirstCall().resolves({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    } as Response);

    // Second call (web app fallback) → 200 with JSON result
    fetchStub.onSecondCall().resolves({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true, result: 'hello', logger_output: '' }),
    } as unknown as Response);

    const sessionMgr = makeSessionManager();
    const result = await execInternal(SCRIPT_ID, 'return "hello"', sessionMgr, { headUrl: HEAD_URL });
    // Web app fallback attempted
    assert.equal(fetchStub.callCount, 2);
  });

  it('does not fall back to web app on scripts.run 404 when no headUrl', async () => {
    fetchStub.resolves({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    } as Response);

    const sessionMgr = makeSessionManager();
    const result = await execInternal(SCRIPT_ID, 'return true', sessionMgr);
    assert.equal(result.success, false);
    assert.equal(fetchStub.callCount, 1); // Only scripts.run called
  });

  it('returns error when not authenticated', async () => {
    const sessionMgr = makeSessionManager(null);
    const result = await execInternal(SCRIPT_ID, 'return true', sessionMgr);
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('authenticated'));
    assert.equal(fetchStub.callCount, 0);
  });
});

describe('getConfigValue', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns string value on success', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({
        done: true,
        response: {
          result: { success: true, result: 'staging-value', error: null },
        },
      }),
    } as Response);

    const sessionMgr = makeSessionManager();
    const result = await getConfigValue(SCRIPT_ID, 'MY_KEY', sessionMgr);
    assert.equal(result, 'staging-value');
  });

  it('returns null on exec failure', async () => {
    fetchStub.resolves({ ok: false, status: 404, text: async () => '' } as Response);
    const sessionMgr = makeSessionManager();
    const result = await getConfigValue(SCRIPT_ID, 'MY_KEY', sessionMgr);
    assert.equal(result, null);
  });

  it('builds JS statement with JSON.stringify for key (injection prevention)', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({
        done: true,
        response: { result: { success: true, result: null, error: null } },
      }),
    } as Response);

    const sessionMgr = makeSessionManager();
    // Key with special characters that could be injection vectors
    await getConfigValue(SCRIPT_ID, 'KEY"WITH\'QUOTES', sessionMgr);

    const [, opts] = fetchStub.firstCall.args as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { parameters: [{ func: string }] };
    const jsStatement = body.parameters[0].func;
    // The key should be JSON.stringify-encoded, not raw
    assert.ok(jsStatement.includes('"KEY\\"WITH\'QUOTES"') || jsStatement.includes('"KEY\\\"WITH\'QUOTES"'));
  });
});

describe('setConfigValue', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('builds JS statement with JSON.stringify for key and value (injection prevention)', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({
        done: true,
        response: { result: { success: true, result: true, error: null } },
      }),
    } as Response);

    const sessionMgr = makeSessionManager();
    await setConfigValue(SCRIPT_ID, 'MY_KEY', 'my-value with "quotes"', sessionMgr);

    const [, opts] = fetchStub.firstCall.args as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { parameters: [{ func: string }] };
    const jsStatement = body.parameters[0].func;
    // Both key and value should be JSON.stringify-encoded
    assert.ok(jsStatement.includes('"MY_KEY"'));
    assert.ok(jsStatement.includes('"my-value with \\"quotes\\""'));
  });

  it('throws on exec failure', async () => {
    fetchStub.resolves({ ok: false, status: 403, text: async () => 'Forbidden' } as Response);
    const sessionMgr = makeSessionManager();
    await assert.rejects(
      () => setConfigValue(SCRIPT_ID, 'KEY', 'value', sessionMgr),
      /setConfigValue failed/
    );
  });
});
