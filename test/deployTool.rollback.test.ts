/**
 * Unit tests for deployTool rollback action (slot-based circular buffer)
 *
 * Uses real temp directories for gas-deploy.json.
 * API operations are mocked via sinon stubs.
 *
 * Verifies:
 *  - No slots error: "run deploy first"
 *  - One rollback: pointer → slot 0 version; stagingActiveSlotIndex = 0
 *  - Two rollbacks (at oldest): "already at oldest" error
 *  - Consumer rollback non-fatal: source succeeds even when consumer updateDeployment rejects
 *  - Slot arrays NOT modified during rollback (only active index + versionNumber change)
 *  - Invalid `to` returns error
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
    updateDeployment: sinon.stub().callsFake((_scriptId: string, deploymentId: string, vn: number) =>
      Promise.resolve({
        deploymentId,
        versionNumber: vn,
        updateTime: new Date().toISOString(),
        webAppUrl: `https://script.google.com/macros/s/${deploymentId}/exec`,
      })
    ),
    getOrCreateHeadDeployment: sinon.stub().resolves({ deploymentId: 'head', versionNumber: 0 }),
    createDeployment: sinon.stub().resolves({ deploymentId: 'newDeploy', versionNumber: 1 }),
    getDeploymentVersionNumber: sinon.stub().resolves(1),
    ...overrides,
  } as unknown as GASDeployOperations;
}

function makeFileOps(): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves([]),
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

describe('deployTool rollback action (slot-based)', () => {
  let tmpDir: string;

  // Two-slot state: slot0 deployed 2024-01-01, slot1 deployed 2024-01-02 (active)
  const twoSlotInfo: DeploymentInfo = {
    stagingDeploymentId: 'AKfycbPointer',
    stagingVersionNumber: 2,
    stagingSlotIds: ['AKfycbSlot0', 'AKfycbSlot1'],
    stagingSlotVersions: [1, 2],
    stagingSlotDescriptions: ['2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'],
    stagingSlotConsumerVersions: [1, 2],
    stagingActiveSlotIndex: 1,
    stagingDeployedAt: '2024-01-02T00:00:00.000Z',
  };

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'rollback-'));
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when no slots exist — "run deploy first"', async () => {
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { stagingDeploymentId: 'AKfycbPointer' } });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      makeDeployOps()
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.toLowerCase().includes('deploy'), `error should mention deploy, got: ${result.error}`);
  });

  it('one rollback: pointer → slot 0 version; stagingActiveSlotIndex = 0', async () => {
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: { ...twoSlotInfo } });

    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.action, 'rollback');
    assert.equal(result.environment, 'staging');
    assert.equal(result.versionNumber, 1, 'rolled back version should be v1 (slot 0)');

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.equal(info?.stagingVersionNumber, 1, 'stagingVersionNumber should be updated to v1');
    assert.equal(info?.stagingActiveSlotIndex, 0, 'active slot should be index 0');

    // Slot arrays MUST remain unchanged
    assert.deepEqual(info?.stagingSlotIds, twoSlotInfo.stagingSlotIds, 'slot IDs must not change during rollback');
    assert.deepEqual(info?.stagingSlotVersions, twoSlotInfo.stagingSlotVersions, 'slot versions must not change during rollback');
    assert.deepEqual(info?.stagingSlotDescriptions, twoSlotInfo.stagingSlotDescriptions, 'slot descriptions must not change during rollback');

    // Pointer update called with v1 (slot 0 version)
    const updateCall = deployOps.updateDeployment as sinon.SinonStub;
    const pointerCall = updateCall.getCalls().find(c => c.args[1] === 'AKfycbPointer');
    assert.ok(pointerCall, 'pointer should be updated');
    assert.equal(pointerCall?.args[2], 1, 'pointer should point to v1');
    assert.strictEqual(pointerCall?.args[3], undefined, 'rollback pointer update must NOT pass description');
  });

  it('at oldest slot: returns "already at oldest" error', async () => {
    // Set active slot to the oldest (index 0)
    const atOldestInfo: DeploymentInfo = { ...twoSlotInfo, stagingActiveSlotIndex: 0, stagingVersionNumber: 1 };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: atOldestInfo });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      makeDeployOps()
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.toLowerCase().includes('oldest'), `error should mention oldest, got: ${result.error}`);
  });

  it('consumer rollback non-fatal: source rollback succeeds when consumer updateDeployment rejects', async () => {
    const infoWithConsumer: DeploymentInfo = {
      ...twoSlotInfo,
      userSymbol: 'SheetsChat',
      stagingConsumerScriptId: 'consumerStagingScriptId',
      stagingConsumerDeploymentId: 'AKfycbConsumerPointer',
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithConsumer });

    // Consumer createVersion (or updateDeployment) will fail
    const deployOps = makeDeployOps({
      createVersion: sinon.stub().rejects(new Error('consumer createVersion failed')),
    });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, 'rollback should succeed even when consumer fails');
    assert.equal(result.versionNumber, 1, 'should roll back to v1');
    assert.ok(result.consumerUpdate?.error?.includes('non-fatal'), `expected non-fatal error, got: ${result.consumerUpdate?.error}`);

    // gas-deploy.json should still be updated for the source
    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];
    assert.equal(info?.stagingVersionNumber, 1);
    assert.equal(info?.stagingActiveSlotIndex, 0);
  });

  it('rollback to=prod walks back prod slot buffer', async () => {
    const infoWithProd: DeploymentInfo = {
      prodDeploymentId: 'AKfycbProdPointer',
      prodVersionNumber: 2,
      prodSlotIds: ['prodSlot0', 'prodSlot1'],
      prodSlotVersions: [1, 2],
      prodSlotDescriptions: ['2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'],
      prodSlotConsumerVersions: [null, null],
      prodActiveSlotIndex: 1,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithProd });

    const deployOps = makeDeployOps();
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'prod' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.environment, 'prod');
    assert.equal(result.versionNumber, 1);

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];
    assert.equal(info?.prodVersionNumber, 1);
    assert.equal(info?.prodActiveSlotIndex, 0);

    // Prod slot arrays unchanged
    assert.deepEqual(info?.prodSlotIds, infoWithProd.prodSlotIds);
    assert.deepEqual(info?.prodSlotVersions, infoWithProd.prodSlotVersions);
  });

  it('single-slot buffer at activeIndex=0 returns "oldest" error', async () => {
    const singleSlotInfo: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbPointer',
      stagingVersionNumber: 1,
      stagingSlotIds: ['AKfycbSlot0'],
      stagingSlotVersions: [1],
      stagingSlotDescriptions: ['2024-01-01T00:00:00.000Z'],
      stagingSlotConsumerVersions: [null],
      stagingActiveSlotIndex: 0,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: singleSlotInfo });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      makeDeployOps()
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.toLowerCase().includes('oldest'), `error should mention oldest, got: ${result.error}`);
  });

  it('3-slot buffer: rollback twice stops at oldest, slot arrays unchanged', async () => {
    const threeSlotInfo: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbPointer',
      stagingVersionNumber: 3,
      stagingSlotIds: ['slot0', 'slot1', 'slot2'],
      stagingSlotVersions: [1, 2, 3],
      stagingSlotDescriptions: ['2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z'],
      stagingSlotConsumerVersions: [null, null, null],
      stagingActiveSlotIndex: 2,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: threeSlotInfo });

    // First rollback: 2 → 1
    const deployOps1 = makeDeployOps();
    const r1 = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      deployOps1
    );
    assert.equal(r1.success, true, `first rollback should succeed, got: ${r1.error}`);
    assert.equal(r1.versionNumber, 2, 'first rollback → v2 (slot 1)');

    // Second rollback: 1 → 0
    const deployOps2 = makeDeployOps();
    const r2 = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      deployOps2
    );
    assert.equal(r2.success, true, `second rollback should succeed, got: ${r2.error}`);
    assert.equal(r2.versionNumber, 1, 'second rollback → v1 (slot 0)');

    // Third rollback: at oldest → error
    const deployOps3 = makeDeployOps();
    const r3 = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback', to: 'staging' },
      makeFileOps(),
      deployOps3
    );
    assert.equal(r3.success, false, 'third rollback should fail — at oldest');
    assert.ok(r3.error?.toLowerCase().includes('oldest'), `error should mention oldest, got: ${r3.error}`);

    // Verify slot arrays are unchanged after all rollbacks
    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];
    assert.deepEqual(info?.stagingSlotIds, threeSlotInfo.stagingSlotIds, 'slot IDs unchanged');
    assert.deepEqual(info?.stagingSlotVersions, threeSlotInfo.stagingSlotVersions, 'slot versions unchanged');
    assert.deepEqual(info?.stagingSlotDescriptions, threeSlotInfo.stagingSlotDescriptions, 'slot descriptions unchanged');
    assert.equal(info?.stagingActiveSlotIndex, 0, 'active slot at oldest');
  });

  it('returns error when `to` is missing', async () => {
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: twoSlotInfo });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'rollback' },
      makeFileOps(),
      makeDeployOps()
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.toLowerCase().includes('invalid'), `got: ${result.error}`);
  });
});
