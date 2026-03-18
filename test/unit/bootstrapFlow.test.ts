/**
 * Unit tests for bootstrap auth flow components:
 *   - authTool.ts bootstrap case
 *   - setupTool.ts deploy-token-broker operation
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleAuthTool } from '../../src/tools/authTool.js';
import { handleSetupTool } from '../../src/tools/setupTool.js';
import type { OAuthClient } from '../../src/auth/oauthClient.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { GASDeployOperations } from '../../src/api/gasDeployOperations.js';

const TEST_BASE = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSessionManager(token: string | null = 'test-token'): SessionManager {
  return {
    getValidToken: sinon.stub().resolves(token),
    getAuthStatus: sinon.stub().resolves({ sessionId: '', authenticated: false, tokenValid: false }),
  } as unknown as SessionManager;
}

function makeOAuthClient(): OAuthClient {
  return {
    startBootstrapFlow: sinon.stub(),
    startLogin: sinon.stub(),
  } as unknown as OAuthClient;
}

function makeFileOps(): GASFileOperations {
  return {
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

function makeProjectOps(): GASProjectOperations {
  return {
    createProject: sinon.stub().resolves({ scriptId: 'new-script-id', title: 'mcp-token-broker' }),
  } as unknown as GASProjectOperations;
}

function makeDeployOps(): GASDeployOperations {
  return {
    createVersion: sinon.stub().resolves({ scriptId: 'new-script-id', versionNumber: 1 }),
    createDeployment: sinon.stub().resolves({
      deploymentId: 'deploy-id',
      versionNumber: 1,
      webAppUrl: 'https://script.google.com/macros/s/DEPLOY_ID/exec',
    }),
  } as unknown as GASDeployOperations;
}

// ── authTool bootstrap case ─────────────────────────────────────────────────

describe('handleAuthTool — bootstrap action', () => {
  let tmpDir: string;
  let cwdStub: sinon.SinonStub;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'auth-bootstrap-'));
    cwdStub = sinon.stub(process, 'cwd').returns(tmpDir);
  });

  afterEach(async () => {
    cwdStub.restore();
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error hint when no URL is configured', async () => {
    const sm = makeSessionManager();
    const client = makeOAuthClient();

    const result = await handleAuthTool({ action: 'bootstrap' }, client, sm);

    assert.equal(result.success, false);
    assert.ok(result.hints?.fix?.includes('deploy-token-broker'), 'hint should mention deploy-token-broker');
    // startBootstrapFlow should NOT be called
    assert.equal((client.startBootstrapFlow as sinon.SinonStub).callCount, 0);
  });

  it('saves tokenBrokerUrl and calls startBootstrapFlow when URL provided', async () => {
    const sm = makeSessionManager();
    const client = makeOAuthClient();
    const url = 'https://script.google.com/macros/s/test-id/exec';
    (client.startBootstrapFlow as sinon.SinonStub).resolves({
      success: true,
      user: { id: '1', email: 'user@example.com', name: 'User', verified_email: true },
    });

    const result = await handleAuthTool({ action: 'bootstrap', tokenBrokerUrl: url }, client, sm);

    assert.equal(result.success, true);
    assert.equal(result.user?.email, 'user@example.com');
    assert.equal((client.startBootstrapFlow as sinon.SinonStub).callCount, 1);
    assert.equal((client.startBootstrapFlow as sinon.SinonStub).firstCall.args[0], url);

    // URL saved to disk
    const configPath = path.join(tmpDir, '.mcp-gas', 'bootstrap-config.json');
    const saved = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { tokenBrokerUrl: string };
    assert.equal(saved.tokenBrokerUrl, url);
  });

  it('loads saved URL from config when no param provided', async () => {
    const sm = makeSessionManager();
    const client = makeOAuthClient();
    const url = 'https://script.google.com/macros/s/saved-id/exec';

    // Pre-save the URL
    const configDir = path.join(tmpDir, '.mcp-gas');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'bootstrap-config.json'), JSON.stringify({ tokenBrokerUrl: url }));

    (client.startBootstrapFlow as sinon.SinonStub).resolves({
      success: true,
      user: { id: '1', email: 'user@example.com', name: 'User', verified_email: true },
    });

    const result = await handleAuthTool({ action: 'bootstrap' }, client, sm);

    assert.equal(result.success, true);
    assert.equal((client.startBootstrapFlow as sinon.SinonStub).firstCall.args[0], url);
  });

  it('returns error when startBootstrapFlow fails', async () => {
    const sm = makeSessionManager();
    const client = makeOAuthClient();
    const url = 'https://script.google.com/macros/s/test-id/exec';
    (client.startBootstrapFlow as sinon.SinonStub).resolves({
      success: false,
      error: 'Bootstrap auth timed out (120s)',
    });

    const result = await handleAuthTool({ action: 'bootstrap', tokenBrokerUrl: url }, client, sm);

    assert.equal(result.success, false);
    assert.equal(result.error, 'Bootstrap auth timed out (120s)');
    assert.ok(result.hints?.fix?.includes('bootstrap'));
  });
});

// ── authTool status case — bootstrap hint ──────────────────────────────────

describe('handleAuthTool — status with bootstrap hint', () => {
  let tmpDir: string;
  let cwdStub: sinon.SinonStub;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'auth-status-bootstrap-'));
    cwdStub = sinon.stub(process, 'cwd').returns(tmpDir);
  });

  afterEach(async () => {
    cwdStub.restore();
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('surfaces bootstrap hint when token expired and bootstrap config exists', async () => {
    const sm = makeSessionManager();
    const client = makeOAuthClient();
    (sm.getAuthStatus as sinon.SinonStub).resolves({
      sessionId: 's1',
      authenticated: true,
      tokenValid: false,
      user: { id: '1', email: 'user@example.com', name: 'User', verified_email: true },
    });

    // Pre-save bootstrap config
    const configDir = path.join(tmpDir, '.mcp-gas');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'bootstrap-config.json'),
      JSON.stringify({ tokenBrokerUrl: 'https://script.google.com/macros/s/test/exec' })
    );

    const result = await handleAuthTool({ action: 'status' }, client, sm);

    assert.equal(result.success, true);
    assert.ok(result.hints?.fix?.includes('bootstrap'), 'hint should mention bootstrap when config exists');
  });
});

// ── setupTool deploy-token-broker ─────────────────────────────────────────

describe('handleSetupTool — deploy-token-broker operation', () => {
  let tmpDir: string;
  let cwdStub: sinon.SinonStub;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'setup-broker-'));
    cwdStub = sinon.stub(process, 'cwd').returns(tmpDir);
  });

  afterEach(async () => {
    cwdStub.restore();
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns auth error when no token', async () => {
    const sm = makeSessionManager(null);
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const deployOps = makeDeployOps();

    const result = await handleSetupTool(
      { operation: 'deploy-token-broker' },
      fileOps, sm, projectOps, deployOps
    );

    assert.equal(result.success, false);
    assert.equal(result.token.present, false);
    assert.ok(result.error?.includes('login') || result.error?.includes('auth'), 'error should mention auth');
  });

  it('creates project, pushes 3 files, creates version + deployment', async () => {
    const sm = makeSessionManager('test-token');
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const deployOps = makeDeployOps();

    const result = await handleSetupTool(
      { operation: 'deploy-token-broker' },
      fileOps, sm, projectOps, deployOps
    );

    assert.equal(result.success, true);
    assert.ok(result.execUrl?.includes('script.google.com'));

    // createProject called once
    assert.equal((projectOps.createProject as sinon.SinonStub).callCount, 1);

    // updateProjectFiles called with 3 files (appsscript, Code, Index)
    assert.equal((fileOps.updateProjectFiles as sinon.SinonStub).callCount, 1);
    const filesArg = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as Array<{name: string; type: string}>;
    assert.equal(filesArg.length, 3);
    const names = filesArg.map(f => f.name);
    assert.ok(names.includes('appsscript'), 'should include appsscript');
    assert.ok(names.includes('Code'), 'should include Code.gs');
    assert.ok(names.includes('Index'), 'should include Index.html');

    // createVersion called
    assert.equal((deployOps.createVersion as sinon.SinonStub).callCount, 1);

    // createDeployment called
    assert.equal((deployOps.createDeployment as sinon.SinonStub).callCount, 1);
  });

  it('saves execUrl to bootstrap-config.json after successful deploy', async () => {
    const sm = makeSessionManager('test-token');
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const deployOps = makeDeployOps();

    await handleSetupTool(
      { operation: 'deploy-token-broker' },
      fileOps, sm, projectOps, deployOps
    );

    const configPath = path.join(tmpDir, '.mcp-gas', 'bootstrap-config.json');
    const saved = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { tokenBrokerUrl: string };
    assert.ok(saved.tokenBrokerUrl?.includes('script.google.com'));
  });

  it('returns error when projectOps not provided', async () => {
    const sm = makeSessionManager('test-token');
    const fileOps = makeFileOps();

    const result = await handleSetupTool(
      { operation: 'deploy-token-broker' },
      fileOps, sm
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Internal error'));
  });

  it('returns error with hint when deployment succeeds but no webAppUrl returned', async () => {
    const sm = makeSessionManager('test-token');
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const deployOps = makeDeployOps();
    // Override createDeployment to return no webAppUrl
    (deployOps.createDeployment as sinon.SinonStub).resolves({
      deploymentId: 'deploy-id',
      versionNumber: 1,
      // no webAppUrl
    });

    const result = await handleSetupTool(
      { operation: 'deploy-token-broker' },
      fileOps, sm, projectOps, deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.hints?.manual?.includes('script.google.com'));
  });
});
