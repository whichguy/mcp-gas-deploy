/**
 * Unit tests for getAuthHint — contextual auth-failure hint builder.
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { getAuthHint } from '../../src/utils/authHints.js';
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
