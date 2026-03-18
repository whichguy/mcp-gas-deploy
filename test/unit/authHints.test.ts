/**
 * Unit tests for getAuthHint and getAuthHintWithSetup — contextual auth-failure hint builders.
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { getAuthHint, getAuthHintWithSetup } from '../../src/utils/authHints.js';
import type { AuthConfig } from '../../src/auth/oauthClient.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';

function makeSessionManager(): SessionManager {
  return {
    getAuthStatus: async () => ({ sessionId: '', authenticated: false, tokenValid: false }),
  } as unknown as SessionManager;
}

describe('getAuthHint', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns default message when getAuthStatus throws', async () => {
    const sm = makeSessionManager();
    sinon.stub(sm, 'getAuthStatus').rejects(new Error('disk read failed'));
    const result = await getAuthHint(sm);
    assert.equal(result, 'Not authenticated. Run auth action="login" first.');
  });

  it('returns default message when authenticated is false', async () => {
    const sm = makeSessionManager();
    sinon.stub(sm, 'getAuthStatus').resolves({
      sessionId: 'sess1',
      authenticated: false,
      tokenValid: false,
    });
    const result = await getAuthHint(sm);
    assert.equal(result, 'Not authenticated. Run auth action="login" first.');
  });

  it('returns token-expired message with email when session exists but token is stale', async () => {
    const sm = makeSessionManager();
    sinon.stub(sm, 'getAuthStatus').resolves({
      sessionId: 'sess1',
      authenticated: true,
      tokenValid: false,
      user: { id: '1', email: 'x@example.com', name: 'X', verified_email: true },
    });
    const result = await getAuthHint(sm);
    assert.equal(result, 'Token expired for x@example.com. Run auth action="login" to re-authenticate.');
  });

  it('returns token-expired message without email when session exists but user has no email', async () => {
    const sm = makeSessionManager();
    sinon.stub(sm, 'getAuthStatus').resolves({
      sessionId: 'sess1',
      authenticated: true,
      tokenValid: false,
    });
    const result = await getAuthHint(sm);
    assert.equal(result, 'Token expired. Run auth action="login" to re-authenticate.');
  });
});

const FAKE_CONFIG: AuthConfig = {
  client_id: 'id',
  client_secret: 'secret',
  redirect_uris: ['http://127.0.0.1'],
  scopes: [],
};

describe('getAuthHintWithSetup', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('includes oauthConfig hint when config loader returns null', async () => {
    const sm = makeSessionManager();
    const { authHint, setupHints } = await getAuthHintWithSetup(sm, undefined, async () => null);
    assert.equal(authHint, 'Not authenticated. Run auth action="login" first.');
    assert.ok('oauthConfig' in setupHints, 'setupHints.oauthConfig should be present');
    assert.match(setupHints.oauthConfig, /setup/);
  });

  it('omits oauthConfig hint when config loader returns a config', async () => {
    const sm = makeSessionManager();
    const { setupHints } = await getAuthHintWithSetup(sm, undefined, async () => FAKE_CONFIG);
    assert.ok(!('oauthConfig' in setupHints), 'setupHints.oauthConfig should be absent');
  });

  it('includes gcpProjectNumber hint when localDir provided and no gcpProjectNumber in gas-deploy.json', async () => {
    const sm = makeSessionManager();
    // /tmp has no gas-deploy.json → getRootConfig returns {} → no gcpProjectNumber
    const { setupHints } = await getAuthHintWithSetup(sm, '/tmp', async () => null);
    assert.ok('gcpProjectNumber' in setupHints, 'setupHints.gcpProjectNumber should be present');
  });

  it('omits gcpProjectNumber hint when localDir is not provided', async () => {
    const sm = makeSessionManager();
    const { setupHints } = await getAuthHintWithSetup(sm, undefined, async () => null);
    assert.ok(!('gcpProjectNumber' in setupHints), 'setupHints.gcpProjectNumber should be absent when no localDir');
  });
});
