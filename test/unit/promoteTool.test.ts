/**
 * Unit tests for handlePromoteTool — core promote operations.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handlePromoteTool } from '../../src/tools/promoteTool.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { SessionManager } from '../../src/auth/sessionManager.js';
import type { GASFile } from '../../src/api/gasTypes.js';

const DEV_SCRIPT_ID = 'devscriptid1234567890abcdefghij';
const STAGING_SOURCE_ID = 'stagingsourceid1234567890abcdef';
const STAGING_CONSUMER_ID = 'stagingconsumerid1234567890abcd';
const STAGING_SPREADSHEET_ID = 'stagingsheet1234567890abcdefghij';
const PROD_SOURCE_ID = 'prodsourceid1234567890abcdefghijk';
const PROD_CONSUMER_ID = 'prodconsumerid1234567890abcdefgh';
const PROD_SPREADSHEET_ID = 'prodsheet1234567890abcdefghijklm';

const TEST_BASE = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');

const MINIMAL_FILES: GASFile[] = [
  { name: 'appsscript', type: 'JSON', source: JSON.stringify({ timeZone: 'UTC', runtimeVersion: 'V8' }) },
  { name: 'common-js/require', type: 'SERVER_JS', source: '// require' },
  { name: 'common-js/ConfigManager', type: 'SERVER_JS', source: '// ConfigManager' },
  { name: 'common-js/__mcp_exec', type: 'SERVER_JS', source: '// __mcp_exec' },
  { name: 'myApp', type: 'SERVER_JS', source: 'function main() {}' },
];

function makeFileOps(files: GASFile[] = MINIMAL_FILES): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves(files),
    updateProjectFiles: sinon.stub().resolves(files),
  } as unknown as GASFileOperations;
}

function makeProjectOps(overrides: Record<string, unknown> = {}): GASProjectOperations {
  return {
    createProject: sinon.stub().callsFake(async (title: string) => ({
      scriptId: title.includes('source') ? STAGING_SOURCE_ID : STAGING_CONSUMER_ID,
      title,
    })),
    createSpreadsheet: sinon.stub().resolves(STAGING_SPREADSHEET_ID),
    getProjectTitle: sinon.stub().resolves('MyApp'),
    getProjectParentId: sinon.stub().resolves(null), // standalone by default
    ...overrides,
  } as unknown as GASProjectOperations;
}

function makeSessionManager(): SessionManager {
  return {
    getValidToken: sinon.stub().resolves('test-token'),
  } as unknown as SessionManager;
}

describe('handlePromoteTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'promote-'));
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: DEV_SCRIPT_ID }),
      'utf-8'
    );
  });

  afterEach(async () => {
    sinon.restore();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ---------- promote operation ----------

  it('promote — returns error when to is missing', async () => {
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, operation: 'promote' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('to'));
  });

  it('promote to staging — happy path: creates environment and pushes files', async () => {
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps({
      createProject: sinon.stub()
        .onFirstCall().resolves({ scriptId: STAGING_SOURCE_ID, title: 'staging-source' })
        .onSecondCall().resolves({ scriptId: STAGING_CONSUMER_ID, title: 'staging-consumer' }),
    });
    const sessionMgr = makeSessionManager();

    // Stub fetch for property sync (non-fatal on failure)
    sinon.stub(globalThis, 'fetch' as never).resolves({
      ok: false, status: 404, text: async () => '',
    } as Response);

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'staging', userSymbol: 'MyApp' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, true);
    assert.equal(result.operation, 'promote');
    assert.equal(result.to, 'staging');
    assert.ok(result.stagingSourceScriptId);
    assert.ok(result.filesPushed! > 0);

    // Verify updateProjectFiles called for staging-source
    const updateStub = fileOps.updateProjectFiles as sinon.SinonStub;
    assert.equal(updateStub.callCount >= 1, true);
    // First update call should be to staging-source
    const firstUpdateId = updateStub.firstCall.args[0] as string;
    assert.equal(firstUpdateId, STAGING_SOURCE_ID);
  });

  it('promote to staging — idempotent: skips create when IDs already in config', async () => {
    // Pre-populate gas-deploy.json with existing environment IDs
    await fs.writeFile(
      path.join(tmpDir, 'gas-deploy.json'),
      JSON.stringify({
        [DEV_SCRIPT_ID]: {
          libStagingSourceScriptId: STAGING_SOURCE_ID,
          libStagingConsumerScriptId: STAGING_CONSUMER_ID,
          libStagingSpreadsheetId: STAGING_SPREADSHEET_ID,
          libUserSymbol: 'MyApp',
        },
      }),
      'utf-8'
    );

    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    sinon.stub(globalThis, 'fetch' as never).resolves({
      ok: false, status: 404, text: async () => '',
    } as Response);

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'staging' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, true);
    // createProject should NOT have been called (IDs already in config)
    const createStub = projectOps.createProject as sinon.SinonStub;
    assert.equal(createStub.callCount, 0);
  });

  it('promote to prod — reads from staging-source, not dev', async () => {
    // Pre-populate staging environment
    await fs.writeFile(
      path.join(tmpDir, 'gas-deploy.json'),
      JSON.stringify({
        [DEV_SCRIPT_ID]: {
          libStagingSourceScriptId: STAGING_SOURCE_ID,
          libStagingConsumerScriptId: STAGING_CONSUMER_ID,
          libStagingSpreadsheetId: STAGING_SPREADSHEET_ID,
          libUserSymbol: 'MyApp',
        },
      }),
      'utf-8'
    );

    const fileOps = makeFileOps();
    const getFilesStub = fileOps.getProjectFiles as sinon.SinonStub;
    const projectOps = makeProjectOps({
      createProject: sinon.stub()
        .onFirstCall().resolves({ scriptId: PROD_SOURCE_ID, title: 'prod-source' })
        .onSecondCall().resolves({ scriptId: PROD_CONSUMER_ID, title: 'prod-consumer' }),
      createSpreadsheet: sinon.stub().resolves(PROD_SPREADSHEET_ID),
    });
    const sessionMgr = makeSessionManager();

    sinon.stub(globalThis, 'fetch' as never).resolves({
      ok: false, status: 404, text: async () => '',
    } as Response);

    await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'prod', userSymbol: 'MyApp' },
      fileOps, projectOps, sessionMgr
    );

    // First getProjectFiles call should be to staging-source, not dev
    const firstReadId = getFilesStub.firstCall.args[0] as string;
    assert.equal(firstReadId, STAGING_SOURCE_ID);
  });

  it('promote to prod — uses stagingSourceScriptId override', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'gas-deploy.json'),
      JSON.stringify({ [DEV_SCRIPT_ID]: {} }),
      'utf-8'
    );

    const fileOps = makeFileOps();
    const getFilesStub = fileOps.getProjectFiles as sinon.SinonStub;
    const projectOps = makeProjectOps({
      createProject: sinon.stub()
        .resolves({ scriptId: PROD_SOURCE_ID, title: 'prod-source' }),
      createSpreadsheet: sinon.stub().resolves(PROD_SPREADSHEET_ID),
    });
    const sessionMgr = makeSessionManager();

    sinon.stub(globalThis, 'fetch' as never).resolves({
      ok: false, status: 404, text: async () => '',
    } as Response);

    const OVERRIDE_SOURCE = 'overridesourceid1234567890abcdef';
    await handlePromoteTool(
      {
        scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'prod',
        userSymbol: 'MyApp', stagingSourceScriptId: OVERRIDE_SOURCE,
      },
      fileOps, projectOps, sessionMgr
    );

    // getProjectFiles should use override source ID
    const firstReadId = getFilesStub.firstCall.args[0] as string;
    assert.equal(firstReadId, OVERRIDE_SOURCE);
  });

  it('promote to prod — returns error when no staging-source and no override', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'gas-deploy.json'),
      JSON.stringify({ [DEV_SCRIPT_ID]: {} }), // no libStagingSourceScriptId
      'utf-8'
    );

    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'prod' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('staging'));
  });

  it('dryRun mode — does not call updateProjectFiles', async () => {
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'staging', dryRun: true, userSymbol: 'MyApp' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.dryRun, true);
    const updateStub = fileOps.updateProjectFiles as sinon.SinonStub;
    assert.equal(updateStub.callCount, 0); // no writes in dry run
  });

  // ---------- status operation ----------

  it('status — returns structured dev/staging/prod sections', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'gas-deploy.json'),
      JSON.stringify({
        [DEV_SCRIPT_ID]: {
          libStagingSourceScriptId: STAGING_SOURCE_ID,
          libStagingPromotedAt: '2024-01-01T00:00:00.000Z',
        },
      }),
      'utf-8'
    );

    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, operation: 'status' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, true);
    assert.ok(result.status);
    assert.ok('dev' in result.status!);
    assert.ok('staging' in result.status!);
    assert.ok('prod' in result.status!);
    assert.equal(result.status!.staging.sourceScriptId, STAGING_SOURCE_ID);
  });

  it('status — adds hint when no staging environment yet', async () => {
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, operation: 'status' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.staging?.includes('promote'));
  });

  // ---------- setup operation ----------

  it('setup — returns error when no templateScriptId', async () => {
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, operation: 'setup' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('templateScriptId'));
  });

  it('setup — returns error when no staging-source library', async () => {
    const TEMPLATE_ID = 'templatescriptid1234567890abcdef';
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, operation: 'setup', templateScriptId: TEMPLATE_ID },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('staging-source'));
  });

  it('setup — wires template when staging-source exists', async () => {
    const TEMPLATE_ID = 'templatescriptid1234567890abcdef';
    await fs.writeFile(
      path.join(tmpDir, 'gas-deploy.json'),
      JSON.stringify({
        [DEV_SCRIPT_ID]: {
          libStagingSourceScriptId: STAGING_SOURCE_ID,
          libUserSymbol: 'MyApp',
        },
      }),
      'utf-8'
    );

    const fileOps = makeFileOps([
      { name: 'appsscript', type: 'JSON', source: JSON.stringify({ timeZone: 'UTC' }) },
    ]);
    const projectOps = makeProjectOps();
    const sessionMgr = makeSessionManager();

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, operation: 'setup', templateScriptId: TEMPLATE_ID, userSymbol: 'MyApp' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, true);
    const updateStub = fileOps.updateProjectFiles as sinon.SinonStub;
    assert.equal(updateStub.callCount, 1);
    const updatedId = updateStub.firstCall.args[0] as string;
    assert.equal(updatedId, TEMPLATE_ID);
  });

  // ---------- userSymbol resolution ----------

  it('userSymbol resolution — params → config → project title fallback', async () => {
    // No userSymbol in params, none in config
    const fileOps = makeFileOps();
    const projectOps = makeProjectOps({
      getProjectTitle: sinon.stub().resolves('SuperApp'),
      createProject: sinon.stub()
        .resolves({ scriptId: STAGING_SOURCE_ID, title: 'source' }),
      createSpreadsheet: sinon.stub().resolves(STAGING_SPREADSHEET_ID),
    });
    const sessionMgr = makeSessionManager();

    sinon.stub(globalThis, 'fetch' as never).resolves({
      ok: false, status: 404, text: async () => '',
    } as Response);

    const result = await handlePromoteTool(
      { scriptId: DEV_SCRIPT_ID, localDir: tmpDir, to: 'staging' },
      fileOps, projectOps, sessionMgr
    );

    assert.equal(result.success, true);
    // Project title 'SuperApp' → userSymbol 'SuperApp'
    // This is stored in hints or the promote result
    // Verify gas-deploy.json was written with a userSymbol
    const configPath = path.join(tmpDir, 'gas-deploy.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.ok(config[DEV_SCRIPT_ID].libUserSymbol);
  });
});
