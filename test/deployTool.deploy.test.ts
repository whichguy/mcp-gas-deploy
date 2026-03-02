/**
 * Unit tests for deployTool deploy action (circular buffer, always staging)
 *
 * Uses real temp directories for gas-deploy.json.
 * API operations are mocked via sinon stubs.
 *
 * Verifies:
 *  - First deploy: slot 0 created, stagingActiveSlotIndex=0, pointer updated to v1
 *  - Second deploy: slot 1 created (lowest undeployed), stagingActiveSlotIndex=1, pointer updated to v2
 *  - Fifth deploy (all 4 slots full): oldest slot overwritten
 *  - deploy ignores `to` param — always targets staging
 *  - Consumer slot co-indexing: stagingSlotConsumerVersions[slotIndex] set to consumer version
 *  - Consumer failure is non-fatal
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

let versionCounter = 1;

function makeDeployOps(overrides: Partial<Record<keyof GASDeployOperations, unknown>> = {}): GASDeployOperations {
  return {
    createVersion: sinon.stub().callsFake(() => {
      const vn = versionCounter++;
      return Promise.resolve({ scriptId: VALID_SCRIPT_ID, versionNumber: vn });
    }),
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
    createDeployment: sinon.stub().callsFake((_scriptId: string, vn: number, desc: string) =>
      Promise.resolve({
        deploymentId: `newDeploy-${desc.slice(0, 10)}`,
        versionNumber: vn,
        updateTime: new Date().toISOString(),
        webAppUrl: `https://script.google.com/macros/s/newDeploy/exec`,
      })
    ),
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

describe('deployTool deploy action (circular buffer)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    versionCounter = 1;
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'deploy-'));
    // Create appsscript.json so the pre-deploy push step doesn't fail on empty directory.
    // Using JSON avoids CommonJS validation (only SERVER_JS files are validated).
    await fs.writeFile(
      path.join(tmpDir, 'appsscript.json'),
      JSON.stringify({ timeZone: 'America/New_York', runtimeVersion: 'V8' }),
      'utf-8'
    );
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('first deploy: creates slot 0, pointer, stagingActiveSlotIndex=0, versionNumber=1', async () => {
    const deployOps = makeDeployOps({
      // First createVersion call returns v1
      createVersion: sinon.stub().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 1 }),
    });
    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.action, 'deploy');
    assert.equal(result.environment, 'staging');
    assert.equal(result.versionNumber, 1);

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.equal(info?.stagingVersionNumber, 1);
    assert.equal(info?.stagingSlotIds?.length, 1, 'should have 1 slot');
    assert.equal(info?.stagingSlotVersions?.[0], 1, 'slot 0 should serve v1');
    assert.equal(info?.stagingActiveSlotIndex, 0, 'active slot should be index 0');
    assert.ok(info?.stagingSlotDescriptions?.[0], 'slot 0 should have description');
    assert.ok(info?.stagingDeploymentId, 'pointer deployment ID should be set');
  });

  it('second deploy: creates slot 1 (lowest undeployed), stagingActiveSlotIndex=1, pointer → v2', async () => {
    // Set up state from first deploy
    const now = new Date().toISOString();
    const initInfo: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbPointer',
      stagingVersionNumber: 1,
      stagingSlotIds: ['AKfycbSlot0'],
      stagingSlotVersions: [1],
      stagingSlotDescriptions: ['2024-01-01T00:00:00.000Z'],
      stagingSlotConsumerVersions: [null],
      stagingActiveSlotIndex: 0,
      stagingDeployedAt: now,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: initInfo });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 2 }),
    });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.versionNumber, 2);

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.equal(info?.stagingSlotIds?.length, 2, 'should now have 2 slots');
    assert.equal(info?.stagingSlotVersions?.[1], 2, 'slot 1 should serve v2');
    assert.equal(info?.stagingActiveSlotIndex, 1, 'active slot should be index 1');
    assert.ok(info?.stagingSlotDescriptions?.[1], 'slot 1 should have description');

    // Pointer update called for AKfycbPointer with v2
    const updateCall = deployOps.updateDeployment as sinon.SinonStub;
    const pointerCall = updateCall.getCalls().find(c => c.args[1] === 'AKfycbPointer');
    assert.ok(pointerCall, 'pointer should be updated');
    assert.equal(pointerCall?.args[2], 2, 'pointer should point to v2');
    assert.equal(pointerCall?.args[3], undefined, 'pointer update should NOT pass description');
  });

  it('fifth deploy (all 4 slots full): overwrites slot with oldest description', async () => {
    // Set up state with 4 full slots — oldest is slot 2 (index 2)
    const initInfo: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbPointer',
      stagingVersionNumber: 4,
      stagingSlotIds: ['slot0', 'slot1', 'slot2', 'slot3'],
      stagingSlotVersions: [1, 2, 3, 4],
      stagingSlotDescriptions: [
        '2024-01-03T00:00:00.000Z',  // slot0 — 3rd oldest
        '2024-01-04T00:00:00.000Z',  // slot1 — 4th oldest (newest)
        '2024-01-01T00:00:00.000Z',  // slot2 — oldest ← should be overwritten
        '2024-01-02T00:00:00.000Z',  // slot3 — 2nd oldest
      ],
      stagingSlotConsumerVersions: [1, 2, 3, 4],
      stagingActiveSlotIndex: 1,
      stagingDeployedAt: new Date().toISOString(),
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: initInfo });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 5 }),
    });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.versionNumber, 5);

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    // Still 4 slots (no new slot created)
    assert.equal(info?.stagingSlotIds?.length, 4, 'should still have 4 slots');
    // Slot 2 (oldest) should be overwritten with v5
    assert.equal(info?.stagingSlotVersions?.[2], 5, 'oldest slot (index 2) should serve v5');
    assert.equal(info?.stagingActiveSlotIndex, 2, 'active slot should be index 2 (the overwritten slot)');
    // Other slots unchanged
    assert.equal(info?.stagingSlotVersions?.[0], 1, 'slot 0 should still serve v1');
    assert.equal(info?.stagingSlotVersions?.[1], 2, 'slot 1 should still serve v2');
    assert.equal(info?.stagingSlotVersions?.[3], 4, 'slot 3 should still serve v4');

    // updateDeployment called for slot2 with v5 and an ISO description
    const updateCall = deployOps.updateDeployment as sinon.SinonStub;
    const slotCall = updateCall.getCalls().find(c => c.args[1] === 'slot2');
    assert.ok(slotCall, 'slot2 should be updated');
    assert.equal(slotCall?.args[2], 5, 'slot2 should point to v5');
    assert.ok(typeof slotCall?.args[3] === 'string', 'slot write should pass ISO description');
  });

  it('consumer slot co-indexed: stagingSlotConsumerVersions[slotIndex] = consumer version', async () => {
    const infoWithConsumer: DeploymentInfo = {
      userSymbol: 'SheetsChat',
      stagingConsumerScriptId: 'consumerStagingScriptId',
      stagingConsumerDeploymentId: 'AKfycbConsumerPointer',
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithConsumer });

    let vn = 0;
    const deployOps = makeDeployOps({
      createVersion: sinon.stub().callsFake(() => {
        vn++;
        return Promise.resolve({ scriptId: vn === 1 ? VALID_SCRIPT_ID : 'consumerStagingScriptId', versionNumber: vn });
      }),
    });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.ok(result.consumerUpdate, 'consumerUpdate should be present');
    assert.ok(!result.consumerUpdate?.error, `unexpected consumer error: ${result.consumerUpdate?.error}`);

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];

    assert.ok(info?.stagingSlotConsumerVersions?.[0] != null, 'consumer version should be stored at slot 0');
  });

  it('consumer failure is non-fatal — deploy succeeds with consumerUpdate.error', async () => {
    const infoWithConsumer: DeploymentInfo = {
      userSymbol: 'SheetsChat',
      stagingConsumerScriptId: 'consumerStagingScriptId',
      stagingConsumerDeploymentId: 'AKfycbConsumerPointer',
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithConsumer });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub()
        .onFirstCall().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 1 })
        .onSecondCall().rejects(new Error('consumer createVersion failed')),
    });

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    assert.equal(result.success, true, 'deploy should succeed even when consumer fails');
    assert.ok(result.consumerUpdate?.error?.includes('non-fatal'), `expected non-fatal error, got: ${result.consumerUpdate?.error}`);

    const config = await readDeployConfig(tmpDir);
    const info = config[VALID_SCRIPT_ID];
    assert.equal(info?.stagingSlotConsumerVersions?.[0], null, 'consumer version should be null on failure');
  });

  it('pointer update passes no description argument', async () => {
    const initInfo: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbPointer',
      stagingVersionNumber: 1,
      stagingSlotIds: ['AKfycbSlot0'],
      stagingSlotVersions: [1],
      stagingSlotDescriptions: ['2024-01-01T00:00:00.000Z'],
      stagingSlotConsumerVersions: [null],
      stagingActiveSlotIndex: 0,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: initInfo });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 2 }),
    });

    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    const updateCall = deployOps.updateDeployment as sinon.SinonStub;
    const pointerCall = updateCall.getCalls().find(c => c.args[1] === 'AKfycbPointer');
    assert.ok(pointerCall, 'pointer should be updated');
    assert.strictEqual(pointerCall?.args[3], undefined, 'pointer update must NOT pass description (invariant)');
  });

  it('slot update passes ISO timestamp as description', async () => {
    const initInfo: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbPointer',
      stagingVersionNumber: 1,
      stagingSlotIds: ['AKfycbSlot0'],
      stagingSlotVersions: [1],
      stagingSlotDescriptions: ['2024-01-01T00:00:00.000Z'],
      stagingSlotConsumerVersions: [null],
      stagingActiveSlotIndex: 0,
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: initInfo });

    const deployOps = makeDeployOps({
      createVersion: sinon.stub().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 2 }),
    });

    await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      makeFileOps(),
      deployOps
    );

    // Slot 1 is new → createDeployment used; slot 0 would use updateDeployment with ISO desc
    // In this case slot1 is new (index 1 >= slotIds.length=1) so createDeployment is called
    const createCall = deployOps.createDeployment as sinon.SinonStub;
    assert.ok(createCall.calledOnce, 'createDeployment should be called for new slot');
    const slotDesc = createCall.firstCall.args[2];
    assert.ok(typeof slotDesc === 'string' && slotDesc.includes('T'), 'slot description should be ISO timestamp');
  });
});
