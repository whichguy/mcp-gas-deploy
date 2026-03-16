/**
 * Unit tests for scriptsRunExecutor
 *
 * Tests the scripts.run API execution path with mocked fetch.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { executeViaScriptsRun } from '../../src/utils/scriptsRunExecutor.js';

const SCRIPT_ID = 'abcdefghijklmnopqrst12345678901';
const TOKEN = 'ya29.test-token';

// --- fetch mock helpers ---

const originalFetch = globalThis.fetch;

function mockFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

describe('executeViaScriptsRun', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct request to scripts.run API', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};

    mockFetch(async (url, init) => {
      capturedUrl = url as string;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        done: true,
        response: { result: { success: true, result: 42 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return 42', TOKEN);

    assert.equal(result.success, true);
    assert.equal(result.result, 42);
    assert.equal(capturedUrl, `https://script.googleapis.com/v1/scripts/${SCRIPT_ID}:run`);
    assert.equal(capturedBody.function, 'apiExec');
    assert.equal(capturedBody.devMode, true);
    assert.deepEqual(capturedBody.parameters, [{ func: 'return 42' }]);
  });

  it('passes spreadsheetId in parameters when provided', async () => {
    let capturedBody: Record<string, unknown> = {};

    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        done: true,
        response: { result: { success: true, result: 'ok' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await executeViaScriptsRun(SCRIPT_ID, 'return "ok"', TOKEN, {
      spreadsheetId: 'sheet123',
    });

    const params = capturedBody.parameters as Record<string, unknown>[];
    assert.equal(params[0].spreadsheetId, 'sheet123');
  });

  it('returns error on HTTP 404', async () => {
    mockFetch(async () => {
      return new Response('Not Found', { status: 404 });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return 1', TOKEN);
    assert.equal(result.success, false, `expected success=false, got ${JSON.stringify(result)}`);
    assert.ok(result.error?.includes('404'), `expected error to include 404, got: ${result.error}`);
    assert.ok(result.hint?.includes('executionApi'), `expected hint to include executionApi, got: ${result.hint}`);
  });

  it('returns error on HTTP 403', async () => {
    mockFetch(async () => {
      return new Response('Forbidden', { status: 403 });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return 1', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('403'));
    assert.ok(result.hint?.includes('scope'));
  });

  it('returns error when scripts.run response has error field', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({
        error: { message: 'Script not found', code: 404, status: 'NOT_FOUND' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return 1', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Script not found'));
  });

  it('returns error when apiExec returns success: false', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({
        done: true,
        response: { result: { success: false, error: 'ReferenceError: x is not defined' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return x', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('ReferenceError'));
  });

  it('returns error when response has no result', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({
        done: true,
        response: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return 1', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('no result'));
    assert.ok(result.hint?.includes('apiExec'));
  });

  it('returns permission hint for PERMISSION_DENIED status', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({
        error: { message: 'Denied', code: 403, status: 'PERMISSION_DENIED' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await executeViaScriptsRun(SCRIPT_ID, 'return 1', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.hint?.includes('OAuth scopes'));
  });

  it('includes Authorization header with Bearer token', async () => {
    let capturedHeaders: Record<string, string> = {};

    mockFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      capturedHeaders = headers;
      return new Response(JSON.stringify({
        done: true,
        response: { result: { success: true, result: null } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await executeViaScriptsRun(SCRIPT_ID, 'return null', TOKEN);
    assert.equal(capturedHeaders['Authorization'], `Bearer ${TOKEN}`);
  });
});
