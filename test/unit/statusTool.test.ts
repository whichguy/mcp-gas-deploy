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

function gasFile(name: string): GASFile {
  return { name, source: `// ${name}`, type: 'SERVER_JS' };
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
      assert.ok(result.error?.includes('Invalid scriptId'));
    });

    it('returns error for localDir outside home directory', async () => {
      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: '/tmp/outside-home' },
        makeFileOps([])
      );
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('home directory'));
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

    it('sets next hint to "in sync" when local and remote file names match', async () => {
      await fs.writeFile(path.join(tmpDir, 'shared.gs'), '// shared', 'utf-8');
      const fileOps = makeFileOps([gasFile('shared')]);

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

  // --- Summary formatting ---

  describe('summary', () => {
    it('shows shared count and local-only file names in summary', async () => {
      await fs.writeFile(path.join(tmpDir, 'shared.gs'), '// shared', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'local-only.gs'), '// local', 'utf-8');
      const fileOps = makeFileOps([gasFile('shared')]);

      const result = await handleStatusTool(
        { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
        fileOps
      );

      assert.equal(result.success, true);
      assert.ok(result.summary.includes('shared'), `summary missing 'shared': ${result.summary}`);
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
  });
});
