/**
 * Unit tests for handleTriggerTool
 *
 * Tests: input validation, auth, headUrl resolution, list/create/delete operations.
 * Uses sinon stubs for fetch, SessionManager, and GASDeployOperations.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleTriggerTool } from '../../src/tools/triggerTool.js';
import { writeDeployConfig } from '../../src/config/deployConfig.js';
import type { GASDeployOperations } from '../../src/api/gasDeployOperations.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';
const HEAD_URL = 'https://script.google.com/macros/s/TEST_DEPLOY_ID/dev';

function makeDeployOps(headUrl: string = HEAD_URL): GASDeployOperations {
  return {
    getOrCreateHeadDeployment: sinon.stub().resolves({
      deploymentId: 'head-deploy-id',
      webAppUrl: headUrl,
      versionNumber: 0,
    }),
  } as unknown as GASDeployOperations;
}

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
  headers['content-type'] = contentType ?? (jsonBody !== undefined ? 'application/json' : 'text/plain');
  return {
    status,
    ok,
    json: sinon.stub().resolves(jsonBody ?? {}),
    text: sinon.stub().resolves(textBody),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('handleTriggerTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'trigger-'));
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { headUrl: HEAD_URL } });
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Validation ---

  it('returns error for invalid scriptId', async () => {
    const result = await handleTriggerTool(
      { scriptId: 'bad', action: 'list' },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid scriptId'));
  });

  it('returns error for missing functionName on create', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', triggerType: 'time', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('functionName'));
  });

  it('returns error for missing triggerType on create', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'myFn', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('triggerType'));
  });

  it('returns error for missing interval on time trigger', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'myFn', triggerType: 'time', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('interval'));
  });

  it('returns error for invalid minutes value', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'myFn', triggerType: 'time', interval: 'minutes', intervalValue: 7, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('minutes') || result.error?.includes('7'));
    assert.ok(result.hints.fix?.includes('1, 5, 10, 15, or 30'));
  });

  it('returns error for delete with no target', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No delete target'));
  });

  // --- Auth ---

  it('returns not authenticated when token is null', async () => {
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list' },
      makeSession(null), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Not authenticated'));
  });

  it('returns browser auth hint when fetch returns HTML', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({ status: 403, text: '<!DOCTYPE html><body>Sign in</body>' }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('browser authorization'));
  });

  // --- List ---

  it('list: returns triggers from GAS', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: {
            success: true,
            triggers: [
              { functionName: 'onTimer', triggerType: 'CLOCK', eventType: 'CLOCK' },
            ],
            totalTriggers: 1,
          },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.totalTriggers, 1);
    assert.equal(result.triggers?.[0]?.functionName, 'onTimer');
  });

  it('list: detailed includes trigger IDs', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: {
            success: true,
            triggers: [
              { functionName: 'onTimer', triggerType: 'CLOCK', eventType: 'CLOCK', triggerId: '12345' },
            ],
            totalTriggers: 1,
          },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', detailed: true, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.triggers?.[0]?.triggerId, '12345');
  });

  it('list: empty list returns success with zero count', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: true, triggers: [], totalTriggers: 0 },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.totalTriggers, 0);
    assert.deepEqual(result.triggers, []);
  });

  // --- Create ---

  it('create: time/minutes trigger returns triggerId', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: true, triggerId: '99', triggerType: 'time', functionName: 'onTimer' },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onTimer', triggerType: 'time', interval: 'minutes', intervalValue: 5, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.triggerId, '99');
    assert.equal(result.functionName, 'onTimer');
  });

  it('create: time/specific-date trigger validates specificDate required', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onTimer', triggerType: 'time', interval: 'specific', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('specificDate'));
  });

  it('create: spreadsheet/onEdit trigger succeeds', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: true, triggerId: '100', triggerType: 'spreadsheet', functionName: 'onEdit' },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onEdit', triggerType: 'spreadsheet', spreadsheetEvent: 'onEdit', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.triggerType, 'spreadsheet');
  });

  it('create: form trigger requires formId', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onForm', triggerType: 'form', formEvent: 'onFormSubmit', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('formId'));
  });

  it('create: GAS error (trigger limit) returns descriptive hint', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: false, error: 'This script has reached the maximum number of triggers (20).' },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onTimer', triggerType: 'time', interval: 'hours', intervalValue: 1, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.hints.fix?.includes('20'));
  });

  // --- Delete ---

  it('delete: by triggerId succeeds', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: { success: true, deleted: 1 } },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', triggerId: '12345', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.deleted, 1);
  });

  it('delete: by functionName succeeds', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: { success: true, deleted: 2 } },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', functionName: 'onTimer', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.deleted, 2);
  });

  it('delete: deleteAll includes warning hint', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: { success: true, deleted: 3 } },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', deleteAll: true, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, true);
    assert.equal(result.deleted, 3);
    assert.ok(result.hints.warning?.includes('ALL'));
  });

  it('delete: trigger not found returns error', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: { success: false, error: 'Trigger not found: 99999' } },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', triggerId: '99999', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not found'));
  });

  // --- headUrl resolution ---

  it('falls back to getOrCreateHeadDeployment when no gas-deploy.json', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: { success: true, triggers: [], totalTriggers: 0 } },
      }),
    );

    // Use a non-existent localDir — no gas-deploy.json available
    const nonExistentDir = path.join(os.homedir(), `nonexistent-trigger-${Date.now()}`);
    const deployOps = makeDeployOps();
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', localDir: nonExistentDir },
      makeSession(), deployOps,
    );
    assert.equal(result.success, true);
    assert.ok((deployOps.getOrCreateHeadDeployment as sinon.SinonStub).calledOnce);
  });

  it('caches headUrl in gas-deploy.json after fallback', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: { success: true, result: { success: true, triggers: [], totalTriggers: 0 } },
      }),
    );

    // Clear gas-deploy.json so fallback is triggered
    await writeDeployConfig(tmpDir, {});
    const deployOps = makeDeployOps();
    await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', localDir: tmpDir },
      makeSession(), deployOps,
    );

    // Verify headUrl was cached
    const configContent = await fs.readFile(path.join(tmpDir, 'gas-deploy.json'), 'utf-8');
    const config = JSON.parse(configContent);
    assert.equal(config[VALID_SCRIPT_ID]?.headUrl, HEAD_URL);
  });

  // --- Additional validation ---

  it('create: invalid triggerId format rejected', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', triggerId: 'abc-invalid', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid triggerId'));
  });

  it('create: document trigger requires documentId', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onOpen', triggerType: 'document', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('documentId'));
  });

  it('create: hours interval validates range 1-24', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'fn', triggerType: 'time', interval: 'hours', intervalValue: 25, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('25') || result.error?.includes('Invalid hours'));
  });

  // --- Raw error surface fallback ---

  it('list: surfaces raw data when IIFE returns success:false without error field', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: false, someField: 'unexpected' },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'list', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('raw:'));
    assert.ok(result.error?.includes('"someField"'));
    assert.ok(result.error?.includes('"unexpected"'));
  });

  it('create: surfaces raw data when IIFE returns success:false without error field', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: false },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'onTimer', triggerType: 'time', interval: 'hours', intervalValue: 1, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('raw:'));
    assert.ok(result.error?.includes('"success":false'));
  });

  it('delete: surfaces raw data when IIFE returns success:false without error field', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      makeFetchResponse({
        status: 200,
        json: {
          success: true,
          result: { success: false },
        },
      }),
    );
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'delete', deleteAll: true, localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('raw:'));
    assert.ok(result.error?.includes('"success":false'));
  });

  it('create: spreadsheet trigger requires spreadsheetEvent', async () => {
    sinon.stub(globalThis, 'fetch');
    const result = await handleTriggerTool(
      { scriptId: VALID_SCRIPT_ID, action: 'create', functionName: 'fn', triggerType: 'spreadsheet', localDir: tmpDir },
      makeSession(), makeDeployOps(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('spreadsheetEvent'));
  });
});
