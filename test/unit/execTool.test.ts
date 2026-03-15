/**
 * Unit tests for handleExecTool
 *
 * Tests: input validation, pre-exec guards, execution flow (push/auth/fetch),
 * redirect following, and workspace URL normalization.
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

  it('js_statement is sent directly to fetch without function validation', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
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
    // Verify the body contains the raw js_statement
    const callArgs = fetchStub.firstCall.args[1] as RequestInit;
    const body = JSON.parse(callArgs.body as string);
    assert.equal(body.func, 'return 2+2');
  });

  it('js_statement with trailing underscore function skips fn validation', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
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

  it('js_statement without return prefix emits returnPrefix hint on success', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
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

  it('js_statement with return prefix does not emit returnPrefix hint on success', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
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
    sinon.stub(globalThis, 'fetch').resolves(
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
    sinon.stub(globalThis, 'fetch').resolves(
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

  it('returns error when no deployment URL in gas-deploy.json', async () => {
    // Override: entry exists but has no URL fields
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: {} });

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No deployment URL'), `got: ${result.error}`);
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

  it('successful exec with module returns result, logs, and filesSync', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
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
    sinon.stub(globalThis, 'fetch').resolves(
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
    sinon.stub(globalThis, 'fetch').resolves(
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

  it('HTML 200 response (new project browser auth) triggers authorization hint', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
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

  it('workspace domain URL is normalized before first fetch', async () => {
    const workspaceUrl = 'https://script.google.com/a/macros/example.com/s/ABC/exec';
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { headUrl: workspaceUrl } });

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({ status: 200, json: { success: true, result: null } }),
    );

    await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.ok(fetchStub.called, 'fetch should have been called');
    const firstUrl: string = fetchStub.firstCall.args[0] as string;
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

  it('redirect to google.com is followed (2 fetch calls, final success)', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onFirstCall().resolves(
      makeFetchResponse({
        status: 302,
        location: 'https://accounts.google.com/o/oauth2/auth?continue=...',
      }),
    );
    fetchStub.onSecondCall().resolves(
      makeFetchResponse({ status: 200, json: { success: true, result: null } }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(fetchStub.callCount, 2, 'should follow the redirect and make 2 fetch calls');
    assert.equal(result.success, true);
  });

  it('redirect to non-google.com is not followed (1 fetch call, result from 302)', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 302,
        text: '',
        location: 'https://evil.com/steal',
      }),
    );

    const result = await handleExecTool(
      { scriptId: VALID_SCRIPT_ID, function: 'myFn', localDir: tmpDir },
      makeFileOps(), makeSession(), makeDeployOps(),
    );

    assert.equal(fetchStub.callCount, 1, 'should not follow non-google.com redirect');
    assert.equal(result.success, false);
  });
});
