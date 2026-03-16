/**
 * Unit tests for gcpSwitch utility
 *
 * Tests the GCP project switch flow with mocked chrome-devtools MCP.
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { switchGcpProject, type ChromeDevtools } from '../../src/utils/gcpSwitch.js';

const SCRIPT_ID = 'abcdefghijklmnopqrst12345678901';
const GCP_NUMBER = '428972970708';

function makeDevtools(overrides: Partial<ChromeDevtools> = {}): ChromeDevtools {
  return {
    navigate_page: overrides.navigate_page ?? (async () => ({})),
    evaluate_script: overrides.evaluate_script ?? (async () => ({ result: '{}' })),
  };
}

describe('switchGcpProject', () => {
  it('returns error when scriptId is empty', async () => {
    const result = await switchGcpProject('', GCP_NUMBER, makeDevtools());
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('required'));
  });

  it('returns error when gcpProjectNumber is empty', async () => {
    const result = await switchGcpProject(SCRIPT_ID, '', makeDevtools());
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('required'));
  });

  it('returns error when XSRF token extraction fails', async () => {
    const devtools = makeDevtools({
      evaluate_script: async () => ({
        result: JSON.stringify({ error: 'XSRF token not found — not signed in to Google in this browser' }),
      }),
    });
    const result = await switchGcpProject(SCRIPT_ID, GCP_NUMBER, devtools);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Token extraction failed'));
    assert.ok(result.hint?.includes('sign in'));
  });

  it('returns success when batchexecute returns [1]', async () => {
    let callCount = 0;
    const devtools = makeDevtools({
      evaluate_script: async () => {
        callCount++;
        if (callCount === 1) {
          // Token extraction
          return { result: JSON.stringify({ xsrf: 'test-xsrf', session: 's', buildLabel: 'b' }) };
        }
        // RPC call
        return { result: JSON.stringify({ success: true }) };
      },
    });
    const result = await switchGcpProject(SCRIPT_ID, GCP_NUMBER, devtools);
    assert.equal(result.success, true);
    assert.equal(result.scriptId, SCRIPT_ID);
    assert.equal(result.gcpProjectNumber, GCP_NUMBER);
  });

  it('returns error when batchexecute RPC fails', async () => {
    let callCount = 0;
    const devtools = makeDevtools({
      evaluate_script: async () => {
        callCount++;
        if (callCount === 1) {
          return { result: JSON.stringify({ xsrf: 'test-xsrf', session: 's', buildLabel: 'b' }) };
        }
        return { result: JSON.stringify({ success: false, error: 'permission denied' }) };
      },
    });
    const result = await switchGcpProject(SCRIPT_ID, GCP_NUMBER, devtools);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('permission denied'));
  });

  it('returns error when chrome-devtools navigate throws', async () => {
    const devtools = makeDevtools({
      navigate_page: async () => { throw new Error('Chrome not running'); },
    });
    const result = await switchGcpProject(SCRIPT_ID, GCP_NUMBER, devtools);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Chrome not running'));
    assert.ok(result.hint?.includes('chrome-devtools'));
  });

  it('returns error when RPC reports generic failure', async () => {
    let callCount = 0;
    const devtools = makeDevtools({
      evaluate_script: async () => {
        callCount++;
        if (callCount === 1) {
          return { result: JSON.stringify({ xsrf: 'test-xsrf', session: '', buildLabel: '' }) };
        }
        return { result: JSON.stringify({ error: 'network timeout' }) };
      },
    });
    const result = await switchGcpProject(SCRIPT_ID, GCP_NUMBER, devtools);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('RPC failed'));
  });

  it('navigates to correct settings URL', async () => {
    let navigatedUrl = '';
    const devtools = makeDevtools({
      navigate_page: async (args) => { navigatedUrl = args.url; return {}; },
      evaluate_script: async () => ({
        result: JSON.stringify({ error: 'test-abort' }),
      }),
    });
    await switchGcpProject(SCRIPT_ID, GCP_NUMBER, devtools);
    assert.equal(navigatedUrl, `https://script.google.com/home/projects/${SCRIPT_ID}/settings`);
  });
});
