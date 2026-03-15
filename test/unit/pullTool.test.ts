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

  it('default localDir resolves to ~/gas-projects/<scriptId>', async () => {
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
    assert.ok(
      result.localDir.includes('gas-projects'),
      `localDir should contain gas-projects, got: ${result.localDir}`,
    );
    assert.ok(
      result.localDir.includes(VALID_SCRIPT_ID),
      `localDir should contain scriptId, got: ${result.localDir}`,
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

  it('writes .clasp.json after successful pull', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);

    // .clasp.json should be written
    const claspContent = await fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8');
    const clasp = JSON.parse(claspContent);
    assert.equal(clasp.scriptId, VALID_SCRIPT_ID);
  });

  it('does NOT update .clasp.json when it already exists (unless reparent)', async () => {
    const existingScriptId = 'existingscriptidxxx1234567890';
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: existingScriptId }),
      'utf-8'
    );

    await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    // .clasp.json should still have the original scriptId
    const claspContent = await fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8');
    const clasp = JSON.parse(claspContent);
    assert.equal(clasp.scriptId, existingScriptId, '.clasp.json should not be overwritten without reparent');
  });

  it('updates .clasp.json when reparent=true', async () => {
    const existingScriptId = 'existingscriptidxxx1234567890';
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: existingScriptId }),
      'utf-8'
    );

    await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, reparent: true },
      makeFileOps([gasFile('main')]),
    );

    // .clasp.json should now have the new scriptId
    const claspContent = await fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8');
    const clasp = JSON.parse(claspContent);
    assert.equal(clasp.scriptId, VALID_SCRIPT_ID, '.clasp.json should be updated with reparent=true');
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

  it('hints include claspJson when .clasp.json is created', async () => {
    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.claspJson?.includes('Created'), `expected Created hint, got: ${result.hints.claspJson}`);
  });

  it('hints include claspJson updated when reparent=true', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: 'oldscriptidxxxxxxxxx1234567890' }),
      'utf-8'
    );

    const result = await handlePullTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, reparent: true },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.claspJson?.includes('Updated'), `expected Updated hint, got: ${result.hints.claspJson}`);
  });

  it('no claspJson hint when .clasp.json already exists and reparent is false', async () => {
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
    assert.equal(result.hints.claspJson, undefined, 'no claspJson hint when .clasp.json already exists');
  });
});
