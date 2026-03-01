/**
 * Unit tests for deployTool promote action
 *
 * Uses real temp directories for gas-deploy.json (sinon cannot stub ESM named exports).
 * API operations (GASDeployOperations, GASFileOperations) are mocked via sinon stubs.
 *
 * Verifies:
 *  - updateDeployment called with correct versionNumber
 *  - createVersion NOT called (promote re-points an existing version)
 *  - response includes previousVersionNumber
 *  - errors surfaced cleanly (missing deployment, HEAD-only source, same env)
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleDeployTool } from '../src/tools/deployTool.js';
import { writeDeployConfig } from '../src/config/deployConfig.js';
import type { GASDeployOperations } from '../src/api/gasDeployOperations.js';
import type { GASFileOperations } from '../src/api/gasFileOperations.js';
import type { DeploymentInfo } from '../src/config/deployConfig.js';

const VALID_SCRIPT_ID = 'abcdefghijklmnopqrst12345678901';

function makeDeployOps(overrides: Partial<Record<keyof GASDeployOperations, unknown>> = {}): GASDeployOperations {
  return {
    createVersion: sinon.stub().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 99 }),
    listVersions: sinon.stub().resolves([]),
    listDeployments: sinon.stub().resolves([]),
    updateDeployment: sinon.stub().resolves({
      deploymentId: 'AKfycbTarget',
      versionNumber: 5,
      updateTime: new Date().toISOString(),
      webAppUrl: 'https://script.google.com/macros/s/targetDeploy/exec',
    }),
    getOrCreateHeadDeployment: sinon.stub().resolves({ deploymentId: 'head', versionNumber: 0 }),
    createDeployment: sinon.stub().resolves({ deploymentId: 'newDeploy', versionNumber: 5, updateTime: new Date().toISOString() }),
    getDeploymentVersionNumber: sinon.stub().resolves(5),
    ...overrides,
  } as unknown as GASDeployOperations;
}

function makeFileOps(): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves([]),
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

describe('deployTool promote action', () => {
  let tmpDir: string;

  // Build timestamps dynamically so tests don't depend on hardcoded dates
  const now = Date.now();
  const stagingDeployedAt = new Date(now - 1 * 60 * 60 * 1000).toISOString();  // 1h ago
  const prodDeployedAt    = new Date(now - 72 * 60 * 60 * 1000).toISOString(); // 72h ago (stale)

  const baseInfo: DeploymentInfo = {
    stagingDeploymentId: 'AKfycbStaging',
    stagingVersionNumber: 5,
    stagingUrl: 'https://script.google.com/macros/s/staging/exec',
    stagingDeployedAt,
    prodDeploymentId: 'AKfycbProd',
    prodVersionNumber: 3,
    prodUrl: 'https://script.google.com/macros/s/prod/exec',
    prodDeployedAt,
  };

  beforeEach(async () => {
    // Must be under homedir — deployTool rejects paths outside it
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'promote-'));
    // Write initial gas-deploy.json with base info
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { ...baseInfo } });
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('calls updateDeployment with source versionNumber', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.action, 'promote');
    assert.equal(result.versionNumber, 5);

    const updateCall = deployOps.updateDeployment as sinon.SinonStub;
    assert.ok(updateCall.calledOnce, 'updateDeployment should be called once');
    assert.equal(updateCall.firstCall.args[2], 5, 'updateDeployment should receive versionNumber=5');
  });

  it('does NOT call createVersion', async () => {
    const deployOps = makeDeployOps();
    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.ok(
      !(deployOps.createVersion as sinon.SinonStub).called,
      'createVersion must NOT be called by promote — promote re-points an existing version'
    );
  });

  it('returns previousVersionNumber from gas-deploy.json', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true);
    assert.equal(result.previousVersionNumber, 3, 'previousVersionNumber should be prod\'s pre-promote version');
  });

  it('writes updated prod versionNumber and timestamp to gas-deploy.json', async () => {
    const deployOps = makeDeployOps();
    const beforeTs = Date.now();
    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );
    const afterTs = Date.now();

    // Read the written config
    const { readDeployConfig } = await import('../src/config/deployConfig.js');
    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.equal(info?.prodVersionNumber, 5, 'prodVersionNumber should be updated to 5');
    assert.ok(info?.prodDeployedAt, 'prodDeployedAt should be written');

    // Timestamp should be at or after when the promote ran
    const ts = new Date(info!.prodDeployedAt!).getTime();
    assert.ok(ts >= beforeTs - 5000, 'prodDeployedAt should not be before the promote call');
    assert.ok(ts <= afterTs + 5000, 'prodDeployedAt should not be far in the future');
  });

  it('returns sourceEnv and targetEnv', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.sourceEnv, 'staging');
    assert.equal(result.targetEnv, 'prod');
  });

  it('errors when from and to are the same', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'prod', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('differ'), `got: ${result.error}`);
  });

  it('errors when source env has no deploymentId', async () => {
    const noStagingInfo: DeploymentInfo = { ...baseInfo, stagingDeploymentId: undefined };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: noStagingInfo });

    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('staging'), `got: ${result.error}`);
  });

  it('errors when source deployment is HEAD-only (getDeploymentVersionNumber throws)', async () => {
    const deployOps = makeDeployOps({
      getDeploymentVersionNumber: sinon.stub().rejects(new Error('HEAD-only')),
    });
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Promote failed'), `got: ${result.error}`);
  });

  it('errors when from is missing', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('from'), `got: ${result.error}`);
  });

  it('errors when to is missing', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('to'), `got: ${result.error}`);
  });

  it('errors when target env has no deploymentId', async () => {
    const noProdInfo: DeploymentInfo = { ...baseInfo, prodDeploymentId: undefined };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: noProdInfo });

    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('prod'), `got: ${result.error}`);
  });

  it('includes rollback hint with previousVersionNumber', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote', from: 'staging', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.rollback?.includes('3'), `rollback hint should mention v3, got: ${result.hints.rollback}`);
  });
});
