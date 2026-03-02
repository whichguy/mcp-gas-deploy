/**
 * Unit tests for handleStatusTool
 *
 * Tests input validation, hint logic, and summary formatting.
 * Uses real temp directories for local files + sinon stubs for GASFileOperations.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleStatusTool } from '../../src/tools/statusTool.js';
import { writeDeployConfig } from '../../src/config/deployConfig.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASFile } from '../../src/api/gasTypes.js';

// 20+ alphanumeric chars — matches SCRIPT_ID_PATTERN
const VALID_SCRIPT_ID = 'abcdefghij1234567890';

function makeFileOps(remoteFiles: GASFile[]): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves(remoteFiles),
    updateProjectFiles: sinon.stub().resolves(remoteFiles),
  } as unknown as GASFileOperations;
}

function gasFile(name: string, source = `// ${name}`): GASFile {
  return { name, source, type: 'SERVER_JS' };
}

describe('handleStatusTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Must be under homedir — statusTool rejects paths outside it
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'status-tool-'));
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Input validation ---

  describe('input validation', () => {
    it('returns error for a too-short scriptId', async () => {
      const result = await handleStatusTool(
        { scriptId: 'too-short' },
        makeFileOps([])
      );
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Invalid scriptId'), `got: ${result.error}`);
    });

    it('returns error for localDir outside home directory', async () => {
      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: '/tmp/outside-home' },
        makeFileOps([])
      );
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('home directory'), `got: ${result.error}`);
    });
  });

  // --- Hint logic ---

  describe('hint logic', () => {
    it('sets next hint to "push or exec to sync" when local-only files exist', async () => {
      await fs.writeFile(path.join(tmpDir, 'main.gs'), '// main', 'utf-8');
      const fileOps = makeFileOps([]); // no remote files

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.hints.next?.includes('push or exec'), `got: ${result.hints.next}`);
    });

    it('sets next hint to "push or exec to sync" when modified files exist', async () => {
      await fs.writeFile(path.join(tmpDir, 'main.gs'), '// updated locally', 'utf-8');
      const fileOps = makeFileOps([gasFile('main', '// original on remote')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.hints.next?.includes('push or exec'), `got: ${result.hints.next}`);
    });

    it('sets next hint to "pull to fetch" when remote-only files exist', async () => {
      // Empty localDir — no local .gs files
      const fileOps = makeFileOps([gasFile('remote')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.hints.next?.includes('pull to fetch'), `got: ${result.hints.next}`);
    });

    it('sets next hint to "in sync" when local and remote file content match', async () => {
      await fs.writeFile(path.join(tmpDir, 'shared.gs'), '// shared', 'utf-8');
      const fileOps = makeFileOps([gasFile('shared', '// shared')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.equal(result.hints.next, 'in sync');
    });

    it('sets next hint to "in sync" when both sides are empty', async () => {
      const fileOps = makeFileOps([]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.equal(result.hints.next, 'in sync');
    });

    // --- Staleness hints ---

    it('emits staleprod hint when prod is >48h behind staging', async () => {
      await fs.writeFile(path.join(tmpDir, 'main.gs'), '// main', 'utf-8');
      const fileOps = makeFileOps([gasFile('main', '// main')]);

      const now = Date.now();
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          stagingVersionNumber: 5,
          stagingDeployedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),  // 2h ago (fresh)
          prodVersionNumber: 3,
          prodDeployedAt: new Date(now - 72 * 60 * 60 * 1000).toISOString(),    // 72h ago (stale)
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.hints.staleprod, `expected staleprod hint, hints: ${JSON.stringify(result.hints)}`);
      assert.ok(result.hints.staleprod.includes('promote'), `hint should mention promote: ${result.hints.staleprod}`);
      assert.ok(result.hints.staleprod.endsWith('action=promote'), `staleprod hint should end with action=promote (no from=/to= params): ${result.hints.staleprod}`);
    });

    it('emits staledev hint when local changes present and staging is >48h old', async () => {
      await fs.writeFile(path.join(tmpDir, 'main.gs'), '// updated locally', 'utf-8');
      const fileOps = makeFileOps([gasFile('main', '// original on remote')]);

      const now = Date.now();
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          stagingVersionNumber: 3,
          stagingDeployedAt: new Date(now - 72 * 60 * 60 * 1000).toISOString(), // 72h ago (stale)
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.hints.staledev, `expected staledev hint, hints: ${JSON.stringify(result.hints)}`);
      assert.ok(result.hints.staledev.includes('staging'), `hint should mention staging: ${result.hints.staledev}`);
      assert.ok(result.hints.staledev.endsWith('action=deploy'), `staledev hint should end with action=deploy (no to= param): ${result.hints.staledev}`);
    });

    it('omits staleness hints when timestamps are missing', async () => {
      await fs.writeFile(path.join(tmpDir, 'main.gs'), '// main', 'utf-8');
      const fileOps = makeFileOps([]);

      // Write config without any timestamps
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          stagingVersionNumber: 3,
          prodVersionNumber: 2,
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(!result.hints.staleprod, 'should not emit staleprod with no timestamps');
      assert.ok(!result.hints.staledev, 'should not emit staledev with no timestamps');
    });

    it('omits staleprod hint when prod is fresher than staging', async () => {
      const fileOps = makeFileOps([]);

      const now = Date.now();
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          stagingVersionNumber: 3,
          stagingDeployedAt: new Date(now - 72 * 60 * 60 * 1000).toISOString(), // 72h ago (old staging)
          prodVersionNumber: 3,
          prodDeployedAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),     // 1h ago (fresh prod)
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(!result.hints.staleprod, 'should not emit staleprod when prod is fresher than staging');
    });

    it('returns error result when getStatus throws', async () => {
      const fileOps = {
        getProjectFiles: sinon.stub().rejects(new Error('API error')),
        updateProjectFiles: sinon.stub(),
      } as unknown as GASFileOperations;

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('API error'), `got: ${result.error}`);
    });
  });

  // --- Deployment URLs ---

  describe('deployment URLs', () => {
    it('returns deployments with all three tiers when all are configured', async () => {
      const fileOps = makeFileOps([]);
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          headUrl: 'https://script.google.com/macros/s/head/dev',
          headDeploymentId: 'AKfycbHead',
          stagingUrl: 'https://script.google.com/macros/s/staging/exec',
          stagingDeploymentId: 'AKfycbStaging',
          stagingVersionNumber: 3,
          prodUrl: 'https://script.google.com/macros/s/prod/exec',
          prodDeploymentId: 'AKfycbProd',
          prodVersionNumber: 2,
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.deployments, 'deployments should be present');
      assert.equal(result.deployments!.head?.url, 'https://script.google.com/macros/s/head/dev');
      assert.equal(result.deployments!.staging?.url, 'https://script.google.com/macros/s/staging/exec');
      assert.equal(result.deployments!.staging?.versionNumber, 3);
      assert.equal(result.deployments!.prod?.url, 'https://script.google.com/macros/s/prod/exec');
      assert.equal(result.deployments!.prod?.versionNumber, 2);
    });

    it('annotates head as /dev and staging/prod as versioned for testing', async () => {
      const fileOps = makeFileOps([]);
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          headUrl: 'https://script.google.com/macros/s/head/dev',
          stagingUrl: 'https://script.google.com/macros/s/staging/exec',
          stagingVersionNumber: 5,
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.ok(result.deployments?.head?.note?.includes('exec'), 'head note should mention exec');
      assert.ok(result.deployments?.staging?.note?.includes('testing'), 'staging note should mention testing');
      assert.ok(result.deployments?.staging?.note?.includes('v5'), 'staging note should include version');
    });

    it('omits deployments field when gas-deploy.json has no URLs configured', async () => {
      const fileOps = makeFileOps([]);
      // No gas-deploy.json — deployments should be absent
      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(!result.deployments, 'deployments should be absent when no config exists');
    });

    it('surfaces stagingSlots with correct versions and isActive flag', async () => {
      const fileOps = makeFileOps([]);
      const now = Date.now();
      const ts1 = new Date(now - 2 * 60 * 60 * 1000).toISOString();
      const ts2 = new Date(now - 1 * 60 * 60 * 1000).toISOString();

      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          stagingDeploymentId: 'AKfycbPointer',
          stagingVersionNumber: 2,
          stagingSlotIds: ['slot0', 'slot1'],
          stagingSlotVersions: [1, 2],
          stagingSlotDescriptions: [ts1, ts2],
          stagingSlotConsumerVersions: [1, 2],
          stagingActiveSlotIndex: 1,
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.deployments?.stagingSlots, 'stagingSlots should be present');
      assert.equal(result.deployments!.stagingSlots!.length, 2, 'should have 2 staging slots');

      const slot0 = result.deployments!.stagingSlots![0];
      assert.equal(slot0.slotIndex, 0);
      assert.equal(slot0.versionNumber, 1);
      assert.equal(slot0.isActive, false, 'slot 0 should not be active');
      assert.ok(slot0.note.includes('rollback'), `slot 0 note should mention rollback, got: ${slot0.note}`);
      assert.ok(slot0.url.includes('slot0'), `slot 0 url should contain deploymentId, got: ${slot0.url}`);
      assert.ok(slot0.url.endsWith('/exec'), `slot 0 url should end with /exec, got: ${slot0.url}`);

      const slot1 = result.deployments!.stagingSlots![1];
      assert.equal(slot1.slotIndex, 1);
      assert.equal(slot1.versionNumber, 2);
      assert.equal(slot1.isActive, true, 'slot 1 should be active');
      assert.ok(slot1.note.includes('active'), `slot 1 note should be "active", got: ${slot1.note}`);
      assert.ok(slot1.url.includes('slot1'), `slot 1 url should contain deploymentId, got: ${slot1.url}`);
    });

    it('omits stagingSlots when stagingSlotIds is absent', async () => {
      const fileOps = makeFileOps([]);
      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          stagingDeploymentId: 'AKfycbPointer',
          stagingVersionNumber: 1,
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(!result.deployments?.stagingSlots, 'stagingSlots should be absent when no slot IDs configured');
    });

    it('surfaces prodSlots with correct isActive flag', async () => {
      const fileOps = makeFileOps([]);
      const ts = new Date().toISOString();

      await writeDeployConfig(tmpDir, {
        [VALID_SCRIPT_ID]: {
          prodDeploymentId: 'AKfycbProdPointer',
          prodVersionNumber: 3,
          prodSlotIds: ['prodSlot0', 'prodSlot1', 'prodSlot2'],
          prodSlotVersions: [1, 2, 3],
          prodSlotDescriptions: [ts, ts, ts],
          prodSlotConsumerVersions: [null, null, null],
          prodActiveSlotIndex: 2,
        },
      });

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.deployments?.prodSlots, 'prodSlots should be present');
      assert.equal(result.deployments!.prodSlots!.length, 3, 'should have 3 prod slots');

      const activeSlot = result.deployments!.prodSlots![2];
      assert.equal(activeSlot.isActive, true, 'slot 2 should be active');
      assert.equal(activeSlot.versionNumber, 3);

      assert.equal(result.deployments!.prodSlots![0].isActive, false);
      assert.equal(result.deployments!.prodSlots![1].isActive, false);
    });
  });

  // --- Summary formatting ---

  describe('summary', () => {
    it('shows "in sync" count in summary when content matches', async () => {
      await fs.writeFile(path.join(tmpDir, 'shared.gs'), '// shared', 'utf-8');
      const fileOps = makeFileOps([gasFile('shared', '// shared')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.summary.includes('in sync'), `summary missing 'in sync': ${result.summary}`);
    });

    it('shows modified file names in summary when content differs', async () => {
      await fs.writeFile(path.join(tmpDir, 'changed.gs'), '// new version', 'utf-8');
      const fileOps = makeFileOps([gasFile('changed', '// old version')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.summary.includes('modified'), `summary missing 'modified': ${result.summary}`);
      assert.ok(result.summary.includes('changed'), `summary missing file name 'changed': ${result.summary}`);
    });

    it('shows local-only file names in summary', async () => {
      await fs.writeFile(path.join(tmpDir, 'local-only.gs'), '// local', 'utf-8');
      const fileOps = makeFileOps([]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.summary.includes('local-only'), `summary missing 'local-only': ${result.summary}`);
    });

    it('shows "No files found" when both sides are empty', async () => {
      const fileOps = makeFileOps([]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.equal(result.summary, 'No files found');
    });

    it('includes remote-only file names in summary', async () => {
      const fileOps = makeFileOps([gasFile('remote-script')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(
        result.summary.includes('remote-script'),
        `summary missing 'remote-script': ${result.summary}`
      );
    });

    it('status object includes modified array', async () => {
      await fs.writeFile(path.join(tmpDir, 'code.gs'), '// new', 'utf-8');
      const fileOps = makeFileOps([gasFile('code', '// old')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.status?.modified, 'status.modified should exist');
      assert.equal(result.status!.modified.length, 1);
      assert.equal(result.status!.modified[0].name, 'code');
    });
  });
});
