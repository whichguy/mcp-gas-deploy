/**
 * Unit tests for handleExecTool
 *
 * Tests: input validation, pre-exec guards, execution flow (push/auth/fetch),
 * redirect following, workspace URL normalization, scripts.run-first routing.
 * Uses sinon stubs for GASFileOperations, GASDeployOperations, SessionManager, and fetch.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleExecTool } from '../../src/tools/execTool.js';
import { writeDeployConfig } from '../../src/config/deployConfig.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASDeployOperations } from '../../src/api/gasDeployOperations.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';
const HEAD_URL = 'https://script.google.com/macros/s/TEST_DEPLOY_ID/dev';

function makeFileOps(): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves([]),
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

function makeDeployOps(headUrl: string = HEAD_URL): GASDeployOperations {
  return {
    getOrCreateHeadDeployment: sinon.stub().resolves({
      deploymentId: 'head-deploy-id',
      webAppUrl: headUrl,
      versionNumber: 0,
    }),
  } as unknown as GASDeployOperations;
}

// SessionManager.getValidToken() returns Promise<string | null>
function makeSession(token: string | null = 'test-token'): SessionManager {
  return {
    getValidToken: sinon.stub().resolves(token),
    getAuthStatus: sinon.stub().resolves({ authenticated: false, tokenValid: false }),
  } as unknown as SessionManager;
}

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
  // Default content-type: application/json when json body provided, text/plain otherwise
  headers['content-type'] = contentType ?? (jsonBody !== undefined ? 'application/json' : 'text/plain');
  return {
    status,
    ok,
    json: sinon.stub().resolves(jsonBody ?? {}),
    text: sinon.stub().resolves(textBody),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

/** Scripts.run success response wrapper */
function makeScriptsRunSuccess(result: unknown): Response {
  return new Response(JSON.stringify({
    done: true,
    response: { result: { success: true, result } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Scripts.run 404 response (not linked to GCP) */
function makeScriptsRun404(): Response {
  return new Response('Not Found', { status: 404 });
}

/**
 * Make a fetch stub that returns 404 for scripts.run calls and the given response for web-app calls.
 * Used for tests that exercise the web-app fallback path.
 */
function stubFetchScriptsRun404ThenWebApp(webAppResponse: Response): sinon.SinonStub {
  return sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request) => {
    if (String(url).includes(':run')) return makeScriptsRun404();
    return webAppResponse;
  });
}

describe('handleExecTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'exec-'));
    // appsscript.json is JSON type → no CommonJS validation → push succeeds
    await fs.writeFile(
      path.join(tmpDir, 'appsscript.json'),
      JSON.stringify({ timeZone: 'America/New_York', runtimeVersion: 'V8' }),
      'utf-8',
    );
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { headUrl: HEAD_URL } });
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Input validation ---

  it('returns error for invalid scriptId', async () => {
    const result = await handleExecTool(
      { scriptId: 'bad', function: 'myFn' },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid scriptId'), `got: ${result.error}`);
  });

  it('returns error for functionName ending with underscore', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn_' },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('trailing') || result.error?.includes('underscore'),
      `got: ${result.error}`,
    );
  });

  it('returns error for invalid module name with quotes', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', module: "common-js/'evil'" },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid module name'), `got: ${result.error}`);
  });

  it('returns error when localDir is outside home directory', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: '/etc/config' },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('home') || result.error?.includes('home directory'),
      `got: ${result.error}`,
    );
  });

  // --- js_statement mode validation ---

  it('returns error when both js_statement and function are provided', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return 2+2', function: 'myFn' },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('mutually exclusive'), `got: ${result.error}`);
  });

  it('returns error when neither js_statement nor function is provided', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Must provide'), `got: ${result.error}`);
  });

  it('returns error when module is used with js_statement', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return 2+2', module: 'utils' },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('module') && result.error?.includes('js_statement'), `got: ${result.error}`);
  });

  it('returns error when args is used with js_statement', async () => {
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return 2+2', args: [1] },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('args') && result.error?.includes('js_statement'), `got: ${result.error}`);
  });

  it('js_statement is sent to fetch (scripts.run 404 → web-app fallback with raw body)', async () => {
    const fetchStub = stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: 4 },
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return 2+2', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, true);
    assert.equal(result.result, 4);
    assert.ok(fetchStub.called, 'fetch should have been called');
    // Verify the web-app call body contains the raw js_statement
    const webAppCall = fetchStub.getCalls().find(c => !String(c.args[0]).includes(':run'));
    assert.ok(webAppCall, 'web-app call should have been made');
    const body = JSON.parse((webAppCall!.args[1] as RequestInit).body as string);
    assert.equal(body.func, 'return 2+2');
  });

  it('js_statement with trailing underscore function skips fn validation', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: 'ok' },
      }),
    );

    // This would fail in function mode (trailing underscore), but js_statement mode skips validation
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: "return require('x').fn_()", localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, true);
  });

  it('js_statement without return prefix emits returnPrefix hint on success (web-app path)', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: undefined },
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'SpreadsheetApp.getActive().setName("test")', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.returnPrefix, `returnPrefix hint should be present, got hints: ${JSON.stringify(result.hints)}`);
    assert.ok(result.hints.returnPrefix?.includes('return'), `hint should mention "return", got: ${result.hints.returnPrefix}`);
  });

  it('js_statement with return prefix does not emit returnPrefix hint on success (web-app path)', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: 4 },
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return 2+2', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, true);
    assert.ok(!result.hints.returnPrefix, `returnPrefix hint should NOT be present when statement starts with return, got: ${result.hints.returnPrefix}`);
  });

  it('js_statement failure hint mentions JavaScript statement, not _main()', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: false, error: 'ReferenceError: foo is not defined' },
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return foo()', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(result.hints.fix?.includes('JavaScript statement'), `hint should mention JavaScript statement, got: ${result.hints.fix}`);
    assert.ok(!result.hints.fix?.includes('_main'), `hint should not mention _main(), got: ${result.hints.fix}`);
  });

  it('js_statement browser auth error does not include exports hint', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 403,
        text: '<!DOCTYPE html><html><body>Sign in</body></html>',
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, js_statement: 'return 2+2', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('browser') || result.error?.includes('authorization'),
      `got: ${result.error}`,
    );
    assert.ok(!result.hints.exports, `exports hint should NOT appear in js_statement mode, got: ${JSON.stringify(result.hints)}`);
  });

  // --- Pre-exec guards ---

  it('returns error with pull hint when localDir does not exist', async () => {
    const nonExistentDir = path.join(os.homedir(), `nonexistent-exec-${Date.now()}`);
    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: nonExistentDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.toLowerCase().includes('not found') || result.error?.includes('Local directory'),
      `got: ${result.error}`,
    );
    assert.ok(result.hints.fix?.includes('pull'), `hint should mention pull, got: ${result.hints.fix}`);
  });

  it('returns 404 setup hint when no deployment URL and no GCP link (scripts.run 404 path)', async () => {
    // Override: entry exists but has no URL fields and no gcpSwitched
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: {} });

    // scripts.run returns 404 (no GCP link), no headUrl to fall back to
    sinon.stub(globalThis, 'fetch').resolves(makeScriptsRun404());

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('404') || result.error?.includes('not linked'), `got: ${result.error}`);
    assert.ok(result.hints.fix?.includes('setup'), `hint should mention setup, got: ${result.hints.fix}`);
    assert.ok(result.hints.learnMore, 'learnMore hint should be present');
  });

  // --- Execution flow ---

  it('auto-push validation failure blocks exec and leaves fetch uncalled', async () => {
    // Invalid .gs file (no _main, no __defineModule__) → CommonJS validation fails
    await fs.writeFile(
      path.join(tmpDir, 'bad.gs'),
      'function badFunc() { return 1; }',
      'utf-8',
    );
    const fetchStub = sinon.stub(globalThis, 'fetch');

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(
      result.validationErrors && result.validationErrors.length > 0,
      'validationErrors should be populated',
    );
    assert.equal(fetchStub.callCount, 0, 'fetch should not be called when validation fails');
  });

  it('returns not authenticated when token is null', async () => {
    sinon.stub(globalThis, 'fetch');

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(null), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Not authenticated'), `got: ${result.error}`);
  });

  it('successful exec with module returns result, logs, and filesSync (web-app fallback path)', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: 'ok', logger_output: 'log' },
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'greet', module: 'common-js/utils', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, true);
    assert.equal(result.result, 'ok');
    assert.equal(result.logs, 'log');
    assert.ok(typeof result.filesSync === 'number' && result.filesSync >= 0);
  });

  it('exec failure from GAS surfaces error and invocation hint', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        json: { success: false, error: 'ReferenceError: myFn is not defined' },
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('ReferenceError'), `got: ${result.error}`);
    assert.ok(result.hints.invocation, 'hints.invocation should be present');
  });

  it('HTML error response triggers browser authorization hint', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 403,
        text: '<!DOCTYPE html><html><body>Sign in</body></html>',
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('browser') || result.error?.includes('authorization'),
      `got: ${result.error}`,
    );
    assert.ok(
      result.hints.fix?.includes('browser') || result.hints.fix?.includes('Browser'),
      `hint should mention browser, got: ${result.hints.fix}`,
    );
  });

  it('browser auth error includes browserAuth automation hint with chrome-devtools steps', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 403,
        text: '<!DOCTYPE html><html><body>Sign in</body></html>',
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(result.hints.browserAuth, 'browserAuth hint should be present');
    assert.ok(result.hints.browserAuth.includes('chrome-devtools'), 'should reference chrome-devtools');
    assert.ok(result.hints.browserAuth.includes('navigate_page'), 'should include navigate step');
    assert.ok(result.hints.browserAuth.includes('wait_for'), 'should include wait step');
    assert.ok(result.hints.browserAuth.includes('close_page'), 'should include cleanup step');
    assert.ok(result.hints.browserAuth.includes(HEAD_URL), 'should include the HEAD URL');
  });

  it('HTML 200 response (new project browser auth) triggers authorization hint', async () => {
    stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({
        status: 200,
        text: '<!DOCTYPE html><html><body>Authorize access</body></html>',
        contentType: 'text/html; charset=utf-8',
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('browser authorization'),
      `got: ${result.error}`,
    );
  });

  // --- Redirect & URL handling ---

  it('workspace domain URL is normalized before web-app fetch', async () => {
    const workspaceUrl = 'https://script.google.com/a/macros/example.com/s/ABC/exec';
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { headUrl: workspaceUrl } });

    const fetchStub = stubFetchScriptsRun404ThenWebApp(
      makeFetchResponse({ status: 200, json: { success: true, result: null } }),
    );

    await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.ok(fetchStub.called, 'fetch should have been called');
    // Find the web-app call (not the scripts.run call)
    const webAppCall = fetchStub.getCalls().find(c => !String(c.args[0]).includes(':run'));
    assert.ok(webAppCall, 'web-app call should have been made');
    const firstUrl: string = webAppCall!.args[0] as string;
    assert.ok(
      !firstUrl.includes('/a/macros/'),
      `URL should not contain workspace domain prefix, got: ${firstUrl}`,
    );
    assert.ok(
      firstUrl.includes('macros/s/ABC/exec'),
      `URL should contain normalized path, got: ${firstUrl}`,
    );
    assert.ok(
      !firstUrl.includes('func='),
      `URL should not contain func param, got: ${firstUrl}`,
    );
    assert.ok(
      firstUrl.includes('_mcp_run=true'),
      `URL should contain _mcp_run=true, got: ${firstUrl}`,
    );
  });

  it('redirect to google.com is followed (scripts.run 404, then web-app 302, then success)', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.callsFake(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes(':run')) {
        return makeScriptsRun404();
      }
      // First web-app call: redirect
      if (fetchStub.callCount === 2) {
        return makeFetchResponse({
          status: 302,
          location: 'https://accounts.google.com/o/oauth2/auth?continue=...',
        });
      }
      // Second web-app call: success
      return makeFetchResponse({ status: 200, json: { success: true, result: null } });
    });

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(fetchStub.callCount, 3, 'should have made 3 fetch calls (scripts.run, web-app, redirect follow)');
    assert.equal(result.success, true);
  });

  it('redirect to non-google.com is not followed', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.callsFake(async (url: string | URL | Request) => {
      if (String(url).includes(':run')) return makeScriptsRun404();
      return makeFetchResponse({
        status: 302,
        text: '',
        location: 'https://evil.com/steal',
      });
    });

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    // 2 calls: scripts.run (404) + web-app (302 to non-google = not followed)
    assert.equal(fetchStub.callCount, 2, 'should not follow non-google.com redirect');
    assert.equal(result.success, false);
  });

  // --- .clasp.json resolution ---

  it('reads scriptId from .clasp.json when scriptId is omitted', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );

    // Stub fetch: scripts.run 404, web-app success
    const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request) => {
      if (String(url).includes(':run')) return makeScriptsRun404();
      return makeFetchResponse({ json: { success: true, result: 42, logger_output: '' } });
    });

    const result = await handleExecTool(
      { function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    fetchStub.restore();
    // Should succeed — scriptId resolved from .clasp.json
    assert.equal(result.success, true, `expected success, got: ${result.error}`);
  });

  it('returns error when neither scriptId nor .clasp.json is available', async () => {
    // Remove .clasp.json if it exists
    try { await fs.unlink(path.join(tmpDir, '.clasp.json')); } catch { /* ENOENT OK */ }

    const result = await handleExecTool(
      { function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No scriptId provided'), `got: ${result.error}`);
  });

  // --- Recurring exec calls ---

  describe('recurring exec calls', () => {
    it('two sequential calls both succeed when token is valid for each', async () => {
      const session = makeSession(); // getValidToken stub resolves 'test-token'
      // Configure independent tokens for each call
      (session.getValidToken as sinon.SinonStub)
        .onFirstCall().resolves('token-1')
        .onSecondCall().resolves('token-2');

      // Return a fresh Response per call — Response body can only be consumed once
      sinon.stub(globalThis, 'fetch').callsFake(async () => makeScriptsRunSuccess(42));

      const result1 = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, js_statement: 'return 42', localDir: tmpDir },
        makeFileOps(), session, makeDeployOps(),
      );
      const result2 = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, js_statement: 'return 42', localDir: tmpDir },
        makeFileOps(), session, makeDeployOps(),
      );

      assert.equal(result1.success, true, `first call failed: ${result1.error}`);
      assert.equal(result2.success, true, `second call failed: ${result2.error}`);
      // getValidToken is called once per handleExecTool invocation (not cached at execTool level)
      assert.ok(
        (session.getValidToken as sinon.SinonStub).calledTwice,
        `getValidToken should be called twice, got: ${(session.getValidToken as sinon.SinonStub).callCount}`,
      );
    });

    it('second call returns auth hint when token expired between calls', async () => {
      const session = makeSession();
      (session.getValidToken as sinon.SinonStub)
        .onFirstCall().resolves('test-token')
        .onSecondCall().resolves(null);
      (session.getAuthStatus as sinon.SinonStub).resolves({
        authenticated: true,
        tokenValid: false,
      });

      sinon.stub(globalThis, 'fetch').resolves(makeScriptsRunSuccess(42));

      const result1 = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, js_statement: 'return 42', localDir: tmpDir },
        makeFileOps(), session, makeDeployOps(),
      );
      const result2 = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, js_statement: 'return 42', localDir: tmpDir },
        makeFileOps(), session, makeDeployOps(),
      );

      assert.equal(result1.success, true, `first call should succeed, got: ${result1.error}`);
      assert.equal(result2.success, false, 'second call should fail when token is null');
      assert.ok(
        result2.error?.toLowerCase().includes('authenticated') || result2.error?.toLowerCase().includes('token'),
        `second call error should mention auth/token, got: ${result2.error}`,
      );
    });
  });

  // --- scripts.run path ---

  describe('scripts.run mode', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('scripts.run succeeds on already-gcpSwitched project — no extra setDeploymentInfo', async () => {
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { gcpSwitched: true } as Record<string, unknown>,
      } as Record<string, unknown>);

      let capturedUrl = '';
      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = url as string;
        return makeScriptsRunSuccess(42);
      }) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return 42' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, true, `expected success, got: ${result.error}`);
      assert.equal(result.result, 42);
      assert.ok(capturedUrl.includes('scripts.run') || capturedUrl.includes(':run'));
      assert.ok(result.hints.execMode?.includes('scripts.run'));

      // gcpSwitched was already true — verify file not modified (still true, no spurious write)
      const { readDeployConfig } = await import('../../src/config/deployConfig.js');
      const config = await readDeployConfig(tmpDir);
      assert.equal((config[VALID_SCRIPT_ID] as Record<string, unknown>)?.gcpSwitched, true);
    });

    it('scripts.run succeeds on non-gcpSwitched project → gcpSwitched persisted', async () => {
      // Config has headUrl but no gcpSwitched
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { headUrl: HEAD_URL } as Record<string, unknown>,
      } as Record<string, unknown>);

      globalThis.fetch = (async () => makeScriptsRunSuccess('ok')) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return "ok"' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, true, `expected success, got: ${result.error}`);
      assert.equal(result.result, 'ok');
      assert.ok(result.hints.execMode?.includes('scripts.run'), `execMode hint: ${result.hints.execMode}`);

      // gcpSwitched should now be persisted in gas-deploy.json
      const { readDeployConfig } = await import('../../src/config/deployConfig.js');
      const config = await readDeployConfig(tmpDir);
      assert.equal(
        (config[VALID_SCRIPT_ID] as Record<string, unknown>)?.gcpSwitched,
        true,
        'gcpSwitched should be persisted after scripts.run success',
      );
    });

    it('scripts.run succeeds on non-gcpSwitched project with no spreadsheetId → gcpSwitched persisted', async () => {
      // No spreadsheetId in config
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { headUrl: HEAD_URL } as Record<string, unknown>,
      } as Record<string, unknown>);

      let capturedBody = '';
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return makeScriptsRunSuccess(null);
      }) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return null' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, true, `expected success, got: ${result.error}`);

      // spreadsheetId should NOT be in the request body (undefined → omitted)
      const body = JSON.parse(capturedBody);
      assert.equal(body.parameters[0].spreadsheetId, undefined, 'spreadsheetId should be omitted when not in config');

      // gcpSwitched should be persisted
      const { readDeployConfig } = await import('../../src/config/deployConfig.js');
      const config = await readDeployConfig(tmpDir);
      assert.equal((config[VALID_SCRIPT_ID] as Record<string, unknown>)?.gcpSwitched, true);
    });

    it('scripts.run returns 404 AND headUrl present → falls through to web-app', async () => {
      // Config has headUrl but no gcpSwitched
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { headUrl: HEAD_URL } as Record<string, unknown>,
      } as Record<string, unknown>);

      let callCount = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        callCount++;
        if (String(url).includes(':run')) return makeScriptsRun404();
        return new Response(JSON.stringify({ success: true, result: 'web-app-result' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return "web-app-result"' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, true, `expected success via web-app fallback, got: ${result.error}`);
      assert.equal(result.result, 'web-app-result');
      assert.equal(callCount, 2, 'should have made 2 calls: scripts.run (404) + web-app');
    });

    it('scripts.run returns 404 AND no headUrl → returns setup hint', async () => {
      // Config has no headUrl, no gcpSwitched
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {} as Record<string, unknown>,
      } as Record<string, unknown>);

      globalThis.fetch = (async () => makeScriptsRun404()) as typeof globalThis.fetch;

      // No GCP link: getOrCreateHeadDeployment returns no webAppUrl (models unlinked project)
      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return 1' },
        makeFileOps(), makeSession(), makeDeployOps(''),
      );

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('404') || result.error?.includes('not linked'), `got: ${result.error}`);
      assert.ok(result.hints.fix?.includes('setup'), `fix hint should mention setup, got: ${result.hints.fix}`);
      assert.ok(result.hints.learnMore, 'learnMore hint should be present');
      assert.ok(!result.hints.browserAuth, 'should not emit browserAuth for 404+no-headUrl path');
    });

    it('scripts.run returns non-404 auth error → returns contextual auth hint', async () => {
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { headUrl: HEAD_URL } as Record<string, unknown>,
      } as Record<string, unknown>);

      // 403 from scripts.run (auth error, not 404)
      globalThis.fetch = (async () => {
        return new Response('Forbidden', { status: 403 });
      }) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return 1' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, false);
      assert.ok(result.hints.execMode?.includes('scripts.run'), `execMode should indicate scripts.run path, got: ${result.hints.execMode}`);
      assert.ok(
        result.hints.fix?.includes('auth') || result.hints.fix?.includes('login') || result.hints.fix?.includes('scope'),
        `fix hint should mention auth/login/scope, got: ${result.hints.fix}`,
      );
    });

    it('skips deployment URL pre-check — no error when no URL and gcpSwitched', async () => {
      // No deployment URLs in config — should NOT fail with "No deployment URL found"
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { gcpSwitched: true } as Record<string, unknown>,
      } as Record<string, unknown>);

      globalThis.fetch = (async () => makeScriptsRunSuccess('ok')) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return "ok"' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, true, `expected success without deploy URLs, got: ${result.error}`);
    });

    it('passes spreadsheetId when present in config', async () => {
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { gcpSwitched: true, spreadsheetId: 'sheet123' } as Record<string, unknown>,
      } as Record<string, unknown>);

      let capturedBody = '';
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return makeScriptsRunSuccess(null);
      }) as typeof globalThis.fetch;

      await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return null' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      const body = JSON.parse(capturedBody);
      assert.equal(body.parameters[0].spreadsheetId, 'sheet123');
    });

    it('returns 404 setup hint for gcpSwitched project where scripts.run returns 404', async () => {
      // gcpSwitched=true but scripts.run returns 404 (e.g., EXECUTION_API disabled)
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { gcpSwitched: true } as Record<string, unknown>,
      } as Record<string, unknown>);

      globalThis.fetch = (async () => makeScriptsRun404()) as typeof globalThis.fetch;

      // No webAppUrl returned from HEAD deployment (models EXECUTION_API disabled scenario)
      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return 1' },
        makeFileOps(), makeSession(), makeDeployOps(''),
      );

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('404') || result.error?.includes('not linked'), `got: ${result.error}`);
      assert.ok(result.hints.fix?.includes('setup'), `hint should mention setup, got: ${result.hints.fix}`);
    });

    it('does not emit browserAuth hint when scripts.run fails with non-404 error', async () => {
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { gcpSwitched: true } as Record<string, unknown>,
      } as Record<string, unknown>);

      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({
          done: true,
          response: { result: { success: false, error: 'test error' } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: 'return x' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, false);
      assert.ok(!result.hints.browserAuth, 'should not emit browserAuth for scripts.run failures');
    });

    it('returns returnPrefix warning for scripts.run success path', async () => {
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: { gcpSwitched: true } as Record<string, unknown>,
      } as Record<string, unknown>);

      globalThis.fetch = (async () => makeScriptsRunSuccess(undefined)) as typeof globalThis.fetch;

      const result = await handleExecTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, js_statement: '2+2' },
        makeFileOps(), makeSession(), makeDeployOps(),
      );

      assert.equal(result.success, true);
      assert.ok(result.hints.returnPrefix?.includes('return'));
    });
  });
});

