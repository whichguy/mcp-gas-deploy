/**
 * Unit tests for propertySync utility.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { syncProperties } from '../../src/utils/propertySync.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

const SOURCE_ID = 'sourcescriptid12345678901234567890';
const TARGET_ID = 'targetscriptid12345678901234567890';
const TOKEN = 'test-token';

function makeSessionManager(): SessionManager {
  return {
    getValidToken: sinon.stub().resolves(TOKEN),
  } as unknown as SessionManager;
}

function makeScriptsRunResponse(result: unknown) {
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

describe('syncProperties', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('filters out MANAGED_PROPERTY_KEYS from sync', async () => {
    // First call: read source props
    fetchStub.onFirstCall().resolves(makeScriptsRunResponse({
      MY_KEY: 'my-value',
      STAGING_URL: 'https://example.com', // managed key — should be skipped
      PROD_URL: 'https://prod.com',        // managed key — should be skipped
      USER_KEY: 'user-value',
    }));
    // Second call: write to target
    fetchStub.onSecondCall().resolves(makeScriptsRunResponse(2));

    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr);

    assert.deepEqual(result.synced.sort(), ['MY_KEY', 'USER_KEY'].sort());
    assert.ok(result.skipped.includes('STAGING_URL'));
    assert.ok(result.skipped.includes('PROD_URL'));
  });

  it('returns error result when source exec fails (non-fatal)', async () => {
    fetchStub.resolves({ ok: false, status: 404, text: async () => 'Not found' } as Response);
    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr);
    assert.deepEqual(result.synced, []);
    assert.ok(result.errors?.length);
    assert.ok(result.errors![0].includes('Could not read source properties'));
  });

  it('returns error result when target write fails (non-fatal)', async () => {
    // Read succeeds
    fetchStub.onFirstCall().resolves(makeScriptsRunResponse({ MY_KEY: 'value' }));
    // Write fails
    fetchStub.onSecondCall().resolves({ ok: false, status: 403, text: async () => 'Forbidden' } as Response);

    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr);
    assert.deepEqual(result.synced, []);
    assert.ok(result.errors?.length);
    assert.ok(result.errors![0].includes('Could not write target properties'));
  });

  it('reconcile mode: deletes target-only keys not in source', async () => {
    // 1: read source
    fetchStub.onFirstCall().resolves(makeScriptsRunResponse({ KEY1: 'val1' }));
    // 2: write to target
    fetchStub.onSecondCall().resolves(makeScriptsRunResponse(1));
    // 3: read target (for reconcile)
    fetchStub.onThirdCall().resolves(makeScriptsRunResponse({ KEY1: 'val1', OLD_KEY: 'old' }));
    // 4: delete OLD_KEY
    fetchStub.onCall(3).resolves(makeScriptsRunResponse(1));

    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr, { reconcile: true });

    assert.deepEqual(result.synced, ['KEY1']);
    assert.deepEqual(result.deleted, ['OLD_KEY']);
  });

  it('does not delete managed keys during reconcile', async () => {
    // 1: read source
    fetchStub.onFirstCall().resolves(makeScriptsRunResponse({ KEY1: 'val1' }));
    // 2: write
    fetchStub.onSecondCall().resolves(makeScriptsRunResponse(1));
    // 3: read target — has managed key too
    fetchStub.onThirdCall().resolves(makeScriptsRunResponse({
      KEY1: 'val1',
      STAGING_URL: 'https://s.example.com', // managed — should NOT be deleted
    }));
    // 4: no delete call needed (no target-only non-managed keys)
    fetchStub.onCall(3).resolves(makeScriptsRunResponse(0));

    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr, { reconcile: true });

    // STAGING_URL should not appear in deleted list
    assert.ok(!result.deleted?.includes('STAGING_URL'));
  });

  it('consumer sync: writes same props to consumer script', async () => {
    const CONSUMER_ID = 'consumer-id-1234567890123456789012';
    // 1: read source
    fetchStub.onFirstCall().resolves(makeScriptsRunResponse({ KEY: 'val' }));
    // 2: write to target
    fetchStub.onSecondCall().resolves(makeScriptsRunResponse(1));
    // 3: write to consumer
    fetchStub.onThirdCall().resolves(makeScriptsRunResponse(1));

    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr, {
      consumerScriptId: CONSUMER_ID,
    });

    assert.ok(result.consumerSync);
    assert.deepEqual(result.consumerSync?.synced, ['KEY']);
  });

  it('skips write and returns empty when source has no non-managed properties', async () => {
    // Source only has managed keys
    fetchStub.onFirstCall().resolves(makeScriptsRunResponse({
      STAGING_URL: 'https://s.example.com',
      PROD_URL: 'https://p.example.com',
    }));

    const sessionMgr = makeSessionManager();
    const result = await syncProperties(SOURCE_ID, TARGET_ID, sessionMgr);

    assert.deepEqual(result.synced, []);
    assert.equal(fetchStub.callCount, 1); // Only read call, no write
  });
});
