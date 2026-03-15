/**
 * Unit tests for gasExecutor.ts
 *
 * Tests: normalizeWebAppUrl, escapeGasString, executeRawJs (redirect following,
 * HTML-200 detection, JSON parsing, timeout).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { normalizeWebAppUrl, escapeGasString, executeRawJs } from '../../src/utils/gasExecutor.js';

function makeFetchResponse(opts: {
  status?: number;
  json?: Record<string, unknown>;
  text?: string;
  location?: string;
  contentType?: string;
}): Response {
  const { status = 200, json: jsonBody, text: textBody = '', location, contentType } = opts;
  const ok = status >= 200 && status < 300;
  const headers: Record<string, string> = {};
  if (location) headers['location'] = location;
  headers['content-type'] = contentType ?? (jsonBody !== undefined ? 'application/json' : 'text/plain');
  return {
    status,
    ok,
    json: sinon.stub().resolves(jsonBody ?? {}),
    text: sinon.stub().resolves(textBody),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('gasExecutor', () => {
  afterEach(() => sinon.restore());

  describe('normalizeWebAppUrl', () => {
    it('converts workspace domain URL to standard format', () => {
      const url = 'https://script.google.com/a/macros/example.com/s/ABC123/exec';
      assert.equal(
        normalizeWebAppUrl(url),
        'https://script.google.com/macros/s/ABC123/exec',
      );
    });

    it('leaves standard URL unchanged', () => {
      const url = 'https://script.google.com/macros/s/ABC123/dev';
      assert.equal(normalizeWebAppUrl(url), url);
    });
  });

  describe('escapeGasString', () => {
    it('escapes backslash, quotes, newlines, and carriage returns', () => {
      assert.equal(escapeGasString(`a\\b'c"d\ne\rf`), `a\\\\b\\'c\\"d\\ne\\rf`);
    });

    it('returns empty string unchanged', () => {
      assert.equal(escapeGasString(''), '');
    });

    it('leaves safe strings unchanged', () => {
      assert.equal(escapeGasString('myFunction'), 'myFunction');
    });
  });

  describe('executeRawJs', () => {
    const HEAD_URL = 'https://script.google.com/macros/s/TEST/dev';
    const TOKEN = 'test-token';

    it('returns success with parsed JSON result', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        makeFetchResponse({ status: 200, json: { success: true, result: 42, logger_output: 'log' } }),
      );

      const result = await executeRawJs('1+1', HEAD_URL, TOKEN);
      assert.equal(result.success, true);
      assert.equal(result.result, 42);
      assert.equal(result.logs, 'log');
    });

    it('returns error for HTTP error with HTML body (browser auth)', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        makeFetchResponse({ status: 403, text: '<!DOCTYPE html><body>Sign in</body>' }),
      );

      const result = await executeRawJs('1+1', HEAD_URL, TOKEN);
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('browser authorization'));
    });

    it('returns error for HTTP 200 with text/html content-type (browser auth)', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        makeFetchResponse({ status: 200, text: '<!DOCTYPE html><body>Authorize</body>', contentType: 'text/html' }),
      );

      const result = await executeRawJs('1+1', HEAD_URL, TOKEN);
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('browser authorization'));
    });

    it('follows redirect through google.com', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        makeFetchResponse({ status: 302, location: 'https://accounts.google.com/auth' }),
      );
      fetchStub.onSecondCall().resolves(
        makeFetchResponse({ status: 200, json: { success: true, result: 'ok' } }),
      );

      const result = await executeRawJs('1+1', HEAD_URL, TOKEN);
      assert.equal(fetchStub.callCount, 2);
      assert.equal(result.success, true);
    });

    it('stops redirect at non-google.com host', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        makeFetchResponse({ status: 302, location: 'https://evil.com/steal', text: '' }),
      );

      const result = await executeRawJs('1+1', HEAD_URL, TOKEN);
      assert.equal(fetchStub.callCount, 1);
      assert.equal(result.success, false);
    });

    it('follows redirect through googleusercontent.com', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        makeFetchResponse({ status: 302, location: 'https://script.googleusercontent.com/resp' }),
      );
      fetchStub.onSecondCall().resolves(
        makeFetchResponse({ status: 200, json: { success: true, result: null } }),
      );

      const result = await executeRawJs('1+1', HEAD_URL, TOKEN);
      assert.equal(fetchStub.callCount, 2);
      assert.equal(result.success, true);
    });

    it('normalizes workspace URL before fetch', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        makeFetchResponse({ status: 200, json: { success: true, result: null } }),
      );

      const wsUrl = 'https://script.google.com/a/macros/example.com/s/ABC/exec';
      await executeRawJs('1+1', wsUrl, TOKEN);

      const fetchedUrl = fetchStub.firstCall.args[0] as string;
      assert.ok(!fetchedUrl.includes('/a/macros/'));
      assert.ok(!fetchedUrl.includes('func='), 'func should not be in URL');
      const opts = fetchStub.firstCall.args[1] as RequestInit;
      assert.equal(opts.method, 'POST');
      assert.equal(opts.body, JSON.stringify({ func: '1+1' }));
    });

    it('returns GAS execution error with logs', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        makeFetchResponse({ status: 200, json: { success: false, error: 'ReferenceError', logger_output: 'debug' } }),
      );

      const result = await executeRawJs('badFn()', HEAD_URL, TOKEN);
      assert.equal(result.success, false);
      assert.equal(result.error, 'ReferenceError');
      assert.equal(result.logs, 'debug');
    });
  });
});
