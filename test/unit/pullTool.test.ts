/**
 * Unit tests for handlePullTool
 *
 * Tests: input validation, path-traversal guard, dryRun listing,
 * actual pull with file writes, failure surfacing, and default/explicit localDir.
 * GASFileOperations is mocked via sinon.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handlePullTool } from '../../src/tools/pullTool.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASFile } from '../../src/api/gasTypes.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';

function makeFileOps(files: GASFile[] = []): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves(files),
    updateProjectFiles: sinon.stub().resolves(files),
  } as unknown as GASFileOperations;
}

function gasFile(name: string, opts: Partial<GASFile> = {}): GASFile {
  return { name, type: 'SERVER_JS', source: `// ${name}`, position: 0, ...opts };
}

describe('handlePullTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'pull-'));
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Input validation ---

  it('returns error for invalid scriptId', async () => {
    const result = await handlePullTool({ scriptId: 'bad' }, makeFileOps());
    assert.equal(result.success, false);
    assert.deepEqual(result.filesPulled, []);
    assert.equal(result.localDir, '');
    assert.ok(result.error?.includes('Invalid scriptId'), `got: ${result.error}`);
  });

  it('returns error when targetDir is outside home directory', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, targetDir: '/etc/config' },
      makeFileOps(),
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('home') || result.error?.includes('home directory'),
      `got: ${result.error}`,
    );
  });

  // --- dryRun mode ---

  it('dryRun lists remote files without writing any to disk', async () => {
    const remoteFiles = [
      gasFile('main'),
      gasFile('utils'),
      gasFile('common-js/helpers'),
    ];
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, targetDir: tmpDir, dryRun: true },
      makeFileOps(remoteFiles),
    );

    assert.equal(result.success, true);
    assert.equal(result.filesPulled.length, 3, 'should list 3 file names');

    // No files should be written to disk in dryRun
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0, 'no files should be written in dryRun');

    assert.ok(
      result.hints.next?.toLowerCase().includes('write') ||
      result.hints.next?.includes('dryRun') ||
      result.hints.next?.includes('without dryRun'),
      `hint should mention writing, got: ${result.hints.next}`,
    );
  });

  it('dryRun with empty remote returns success with empty filesPulled', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, targetDir: tmpDir, dryRun: true },
      makeFileOps([]),
    );
    assert.equal(result.success, true);
    assert.deepEqual(result.filesPulled, []);
  });

  // --- Actual pull ---

  it('successful pull writes files locally and returns hints', async () => {
    const remoteFiles = [
      gasFile('main', { source: '// main code' }),
      gasFile('utils', { source: '// utils code' }),
    ];
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, targetDir: tmpDir },
      makeFileOps(remoteFiles),
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.equal(result.filesPulled.length, 2);

    // Both .gs files should exist on disk
    const mainExists = await fs.access(path.join(tmpDir, 'main.gs')).then(() => true).catch(() => false);
    const utilsExists = await fs.access(path.join(tmpDir, 'utils.gs')).then(() => true).catch(() => false);
    assert.ok(mainExists, 'main.gs should be written to disk');
    assert.ok(utilsExists, 'utils.gs should be written to disk');

    assert.ok(result.localDir, 'localDir should be set');
    assert.ok(
      result.hints.next?.includes('push') || result.hints.next?.includes('exec'),
      `hint should mention push/exec, got: ${result.hints.next}`,
    );
  });

  it('pull failure surfaces error and returns success:false', async () => {
    const failingOps = {
      getProjectFiles: sinon.stub().rejects(new Error('403 Forbidden')),
      updateProjectFiles: sinon.stub().resolves([]),
    } as unknown as GASFileOperations;

    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, targetDir: tmpDir },
      failingOps,
    );

    assert.equal(result.success, false);
    assert.ok(result.error, 'error should be set');
  });

  it('default localDir resolves to CWD when only scriptId provided', async () => {
    // Use a stub that rejects so we get result without pulling (we only care about localDir)
    const failingOps = {
      getProjectFiles: sinon.stub().rejects(new Error('test')),
      updateProjectFiles: sinon.stub().resolves([]),
    } as unknown as GASFileOperations;

    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID },
      failingOps,
    );

    // result.localDir is always set (even on failure)
    assert.equal(
      result.localDir, process.cwd(),
      `localDir should be CWD, got: ${result.localDir}`,
    );
  });

  // --- Path handling ---

  it('explicit targetDir within home is accepted and returned as localDir', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, targetDir: tmpDir },
      makeFileOps([]),
    );

    // dryRun is false (actual pull) — pull succeeds with 0 files from empty remote
    assert.equal(result.success, true);
    assert.equal(result.localDir, tmpDir, 'localDir should equal the provided targetDir');
  });

  // --- .clasp.json resolution ---

  it('reads scriptId from .clasp.json when scriptId is omitted', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );

    const result = await handlePullTool(
      { localDir: tmpDir, dryRun: true },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);
    assert.equal(result.localDir, tmpDir);
    assert.equal(result.filesPulled.length, 1);
  });

  it('pull does NOT write .clasp.json (create tool handles that)', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);

    // .clasp.json should NOT be written by pull
    const exists = await fs.access(path.join(tmpDir, '.clasp.json')).then(() => true).catch(() => false);
    assert.equal(exists, false, '.clasp.json should not be created by pull');
  });

  it('pull fails on non-existent directory with clean error', async () => {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');

    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: nonExistentDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('does not exist'), `error should mention non-existent dir, got: ${result.error}`);
  });

  it('pull does not init git', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);

    // .git should NOT be created by pull
    const gitExists = await fs.access(path.join(tmpDir, '.git')).then(() => true).catch(() => false);
    assert.equal(gitExists, false, '.git should not be created by pull');
  });

  it('returns error when neither scriptId nor .clasp.json is available', async () => {
    const result = await handlePullTool(
      { localDir: tmpDir },
      makeFileOps([]),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No scriptId provided'), `got: ${result.error}`);
  });

  it('accepts localDir as alias for targetDir', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, dryRun: true },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);
    assert.equal(result.localDir, tmpDir);
  });

  // --- Dynamic hints ---

  it('hints include scriptId when resolved from .clasp.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );

    const result = await handlePullTool(
      { localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.scriptId?.includes('from .clasp.json'), `expected clasp-json hint, got: ${result.hints.scriptId}`);
  });

  it('no claspJson hints from pull (create handles .clasp.json)', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);
    assert.equal(result.hints.claspJson, undefined, 'no claspJson hint from pull');
    assert.equal(result.hints.gitignore, undefined, 'no gitignore hint from pull');
  });
});
