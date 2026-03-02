/**
 * Unit tests for deployTool promote action
 *
 * promote is always staging → prod — no from/to params required.
 * Uses real temp directories for gas-deploy.json (sinon cannot stub ESM named exports).
 * API operations (GASDeployOperations, GASFileOperations) are mocked via sinon stubs.
 *
 * Verifies:
 *  - updateDeployment called with correct versionNumber (prod pointer)
 *  - createVersion NOT called (promote re-points an existing version)
 *  - response includes previousVersionNumber
 *  - prod slot written on promote (createDeployment called for first slot)
 *  - errors surfaced cleanly (missing staging deployment, HEAD-only source)
 *  - consumer update surfaced in response (non-fatal)
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleDeployTool } from '../src/tools/deployTool.js';
import { writeDeployConfig, readDeployConfig } from '../src/config/deployConfig.js';
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
    createDeployment: sinon.stub().resolves({ deploymentId: 'newProdSlot', versionNumber: 5, updateTime: new Date().toISOString() }),
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

  it('calls updateDeployment with source versionNumber (prod pointer)', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.action, 'promote');
    assert.equal(result.versionNumber, 5);

    const updateCall = deployOps.updateDeployment as sinon.SinonStub;
    // First updateDeployment call should be for the prod pointer with versionNumber=5
    assert.ok(updateCall.called, 'updateDeployment should be called for prod pointer');
    assert.equal(updateCall.firstCall.args[2], 5, 'updateDeployment should receive versionNumber=5');
  });

  it('does NOT call createVersion', async () => {
    const deployOps = makeDeployOps();
    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
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
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
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
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );
    const afterTs = Date.now();

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.equal(info?.prodVersionNumber, 5, 'prodVersionNumber should be updated to 5');
    assert.ok(info?.prodDeployedAt, 'prodDeployedAt should be written');

    // Timestamp should be at or after when the promote ran
    const ts = new Date(info!.prodDeployedAt!).getTime();
    assert.ok(ts >= beforeTs - 5000, 'prodDeployedAt should not be before the promote call');
    assert.ok(ts <= afterTs + 5000, 'prodDeployedAt should not be far in the future');
  });

  it('writes prod slot to gas-deploy.json on first promote (Track B)', async () => {
    const deployOps = makeDeployOps();
    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.ok(info?.prodSlotIds?.length === 1, 'prodSlotIds should have 1 slot after first promote');
    assert.equal(info?.prodSlotVersions?.[0], 5, 'prodSlotVersions[0] should be 5');
    assert.ok(info?.prodSlotDescriptions?.[0], 'prodSlotDescriptions[0] should be set');
    assert.equal(info?.prodActiveSlotIndex, 0, 'prodActiveSlotIndex should be 0');

    // createDeployment should be called for the new slot
    const createCall = deployOps.createDeployment as sinon.SinonStub;
    assert.ok(createCall.calledOnce, 'createDeployment should be called once for first prod slot');
  });

  it('returns sourceEnv=staging and targetEnv=prod', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.sourceEnv, 'staging');
    assert.equal(result.targetEnv, 'prod');
  });

  it('errors when staging deployment is missing', async () => {
    const noStagingInfo: DeploymentInfo = { ...baseInfo, stagingDeploymentId: undefined };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: noStagingInfo });

    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
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
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Promote failed'), `got: ${result.error}`);
  });

  it('errors when prod deployment is missing', async () => {
    const noProdInfo: DeploymentInfo = { ...baseInfo, prodDeploymentId: undefined };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: noProdInfo });

    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('prod'), `got: ${result.error}`);
  });

  it('includes rollback hint pointing to action=rollback to="prod"', async () => {
    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true);
    assert.ok(
      result.hints.rollback?.includes('rollback'),
      `rollback hint should mention rollback action, got: ${result.hints.rollback}`
    );
    assert.ok(
      result.hints.rollback?.includes('prod'),
      `rollback hint should mention prod environment, got: ${result.hints.rollback}`
    );
  });

  it('prod slot description preserves staging deploy timestamp (not promote time)', async () => {
    const stagingSlotTs = '2026-01-15T10:30:00.000Z';
    const infoWithSlots: DeploymentInfo = {
      ...baseInfo,
      stagingSlotIds: ['stagingSlot0'],
      stagingSlotVersions: [5],
      stagingSlotDescriptions: [stagingSlotTs],
      stagingActiveSlotIndex: 0,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithSlots });

    const deployOps = makeDeployOps();
    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.equal(
      info?.prodSlotDescriptions?.[0],
      stagingSlotTs,
      'prodSlotDescriptions[0] should match staging slot deploy timestamp'
    );
  });

  it('prod slot description falls back to current time when staging slot descriptions are missing', async () => {
    // baseInfo has no staging slot descriptions
    const deployOps = makeDeployOps();
    const beforeTs = Date.now();
    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );
    const afterTs = Date.now();

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.ok(info?.prodSlotDescriptions?.[0], 'prodSlotDescriptions[0] should be set');
    const slotTs = new Date(info!.prodSlotDescriptions![0]).getTime();
    assert.ok(slotTs >= beforeTs - 5000, 'fallback timestamp should be recent (not before call)');
    assert.ok(slotTs <= afterTs + 5000, 'fallback timestamp should be recent (not far in future)');
  });

  it('consumer update succeeds when prodConsumerScriptId and userSymbol are set', async () => {
    const infoWithConsumer: DeploymentInfo = {
      ...baseInfo,
      userSymbol: 'SheetsChat',
      prodConsumerScriptId: 'consumerProdScriptId',
      prodConsumerDeploymentId: 'AKfycbConsumerProd',
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithConsumer });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub().resolves({ scriptId: 'consumerProdScriptId', versionNumber: 7 }),
    });
    const fileOps = makeFileOps();

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      fileOps,
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.ok(result.consumerUpdate, 'consumerUpdate should be present');
    assert.equal(result.consumerUpdate?.scriptId, 'consumerProdScriptId');
    assert.ok(!result.consumerUpdate?.error, `unexpected consumer error: ${result.consumerUpdate?.error}`);
  });

  it('consumer failure is non-fatal — promote succeeds with consumerUpdate.error', async () => {
    const infoWithConsumer: DeploymentInfo = {
      ...baseInfo,
      userSymbol: 'SheetsChat',
      prodConsumerScriptId: 'consumerProdScriptId',
      prodConsumerDeploymentId: 'AKfycbConsumerProd',
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithConsumer });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub().rejects(new Error('consumer createVersion failed')),
    });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'promote' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, 'promote should succeed even when consumer fails');
    assert.ok(result.consumerUpdate?.error?.includes('non-fatal'), `expected non-fatal error, got: ${result.consumerUpdate?.error}`);
  });
});
