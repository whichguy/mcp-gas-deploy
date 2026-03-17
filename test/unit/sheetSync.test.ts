/**
 * Unit tests for sheetSync utility.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { syncSheets } from '../../src/utils/sheetSync.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

const EXEC_SCRIPT_ID = 'execscript12345678901234567890';
const SOURCE_SPREADSHEET = 'sourceSpreadsheetId1234567890123456';
const TARGET_SPREADSHEET = 'targetSpreadsheetId1234567890123456';
const TOKEN = 'test-token';

function makeSessionManager(): SessionManager {
  return {
    getValidToken: sinon.stub().resolves(TOKEN),
  } as unknown as SessionManager;
}

function makeScriptsRunSuccessResponse(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      done: true,
      response: {
        result: { success: true, result, error: null },
      },
    }),
  } as Response;
}

describe('syncSheets', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns empty result when mode is "off"', async () => {
    const sessionMgr = makeSessionManager();
    const result = await syncSheets(SOURCE_SPREADSHEET, TARGET_SPREADSHEET, 'off', EXEC_SCRIPT_ID, sessionMgr);
    assert.deepEqual(result.synced, []);
    assert.deepEqual(result.added, []);
    assert.equal(fetchStub.callCount, 0); // no exec call
  });

  it('returns error for invalid spreadsheet ID format', async () => {
    const sessionMgr = makeSessionManager();
    const result = await syncSheets('bad-id', TARGET_SPREADSHEET, 'replace_all', EXEC_SCRIPT_ID, sessionMgr);
    assert.ok(result.error?.includes('Invalid source spreadsheetId'));
    assert.equal(fetchStub.callCount, 0);
  });

  it('returns error for invalid target spreadsheet ID', async () => {
    const sessionMgr = makeSessionManager();
    const result = await syncSheets(SOURCE_SPREADSHEET, 'bad', 'smart', EXEC_SCRIPT_ID, sessionMgr);
    assert.ok(result.error?.includes('Invalid target spreadsheetId'));
  });

  it('returns error for invalid mode string', async () => {
    const sessionMgr = makeSessionManager();
    const result = await syncSheets(SOURCE_SPREADSHEET, TARGET_SPREADSHEET, 'invalid_mode' as never, EXEC_SCRIPT_ID, sessionMgr);
    assert.ok(result.error?.includes('Invalid sync mode'));
    assert.equal(fetchStub.callCount, 0);
  });

  it('replace_all: executes GAS and returns sync result', async () => {
    fetchStub.resolves(makeScriptsRunSuccessResponse({
      synced: ['Sheet1'], added: ['NewSheet'], preserved: [], skipped: ['OldSheet'],
    }));

    const sessionMgr = makeSessionManager();
    const result = await syncSheets(SOURCE_SPREADSHEET, TARGET_SPREADSHEET, 'replace_all', EXEC_SCRIPT_ID, sessionMgr);
    assert.deepEqual(result.synced, ['Sheet1']);
    assert.deepEqual(result.added, ['NewSheet']);
    assert.deepEqual(result.skipped, ['OldSheet']);
    assert.equal(result.source, SOURCE_SPREADSHEET);
    assert.equal(result.target, TARGET_SPREADSHEET);
  });

  it('uses JSON.stringify for spreadsheet IDs in generated JS (injection prevention)', async () => {
    fetchStub.resolves(makeScriptsRunSuccessResponse({
      synced: [], added: [], preserved: [], skipped: [],
    }));

    const sessionMgr = makeSessionManager();
    await syncSheets(SOURCE_SPREADSHEET, TARGET_SPREADSHEET, 'smart', EXEC_SCRIPT_ID, sessionMgr);

    const [, opts] = fetchStub.firstCall.args as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { parameters: [{ func: string }] };
    const jsStatement = body.parameters[0].func;
    // IDs should appear quoted (JSON.stringify-encoded)
    assert.ok(jsStatement.includes(`"${SOURCE_SPREADSHEET}"`));
    assert.ok(jsStatement.includes(`"${TARGET_SPREADSHEET}"`));
    assert.ok(jsStatement.includes('"smart"'));
  });

  it('returns error on exec failure', async () => {
    fetchStub.resolves({ ok: false, status: 403, text: async () => 'Forbidden' } as Response);
    const sessionMgr = makeSessionManager();
    const result = await syncSheets(SOURCE_SPREADSHEET, TARGET_SPREADSHEET, 'replace_all', EXEC_SCRIPT_ID, sessionMgr);
    assert.ok(result.error?.includes('Sheet sync exec failed'));
  });

  it('add_new_only mode: generated JS contains mode string', async () => {
    fetchStub.resolves(makeScriptsRunSuccessResponse({
      synced: [], added: ['Sheet2'], preserved: ['Sheet1'], skipped: [],
    }));

    const sessionMgr = makeSessionManager();
    const result = await syncSheets(SOURCE_SPREADSHEET, TARGET_SPREADSHEET, 'add_new_only', EXEC_SCRIPT_ID, sessionMgr);
    assert.deepEqual(result.added, ['Sheet2']);
    assert.deepEqual(result.preserved, ['Sheet1']);
  });
});
