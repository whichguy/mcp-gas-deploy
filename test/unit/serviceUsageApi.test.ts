/**
 * Unit tests for serviceUsageApi — enableAppsScriptApi.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { enableAppsScriptApi } from '../../src/utils/serviceUsageApi.js';

const VALID_GCP_NUM = '428972970708';
const TOKEN = 'test-token-abc';

describe('enableAppsScriptApi', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns success: true on 200 response', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({ name: 'projects/123/services/script.googleapis.com:ENABLED', state: 'ENABLED' }),
    } as Response);

    const result = await enableAppsScriptApi(VALID_GCP_NUM, TOKEN);
    assert.equal(result.success, true);

    // Verify correct URL and auth header used
    const [url, opts] = fetchStub.firstCall.args as [string, RequestInit];
    assert.ok(url.includes(VALID_GCP_NUM));
    assert.ok(url.includes('script.googleapis.com:enable'));
    assert.equal((opts.headers as Record<string, string>)['Authorization'], `Bearer ${TOKEN}`);
  });

  it('returns { success: false, hint } on 403 response (non-fatal)', async () => {
    fetchStub.resolves({
      ok: false,
      status: 403,
      text: async () => 'PERMISSION_DENIED',
    } as Response);

    const result = await enableAppsScriptApi(VALID_GCP_NUM, TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.hint);
    assert.ok(result.hint!.includes('Manually enable'));
  });

  it('returns { success: false, hint } on 401 response (non-fatal)', async () => {
    fetchStub.resolves({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    const result = await enableAppsScriptApi(VALID_GCP_NUM, TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.hint);
  });

  it('returns { success: false } on network error (non-fatal)', async () => {
    fetchStub.rejects(new Error('Network error'));

    const result = await enableAppsScriptApi(VALID_GCP_NUM, TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('rejects invalid gcpProjectNumber format', async () => {
    const result = await enableAppsScriptApi('not-a-number', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Invalid gcpProjectNumber'));
    assert.equal(fetchStub.callCount, 0); // no fetch called
  });

  it('rejects too-short gcpProjectNumber', async () => {
    const result = await enableAppsScriptApi('123', TOKEN);
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Invalid gcpProjectNumber'));
  });
});
