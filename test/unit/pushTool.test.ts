/**
 * Unit tests for handlePushTool
 *
 * Tests: input validation, path-traversal guard, dryRun listing,
 * validation error surfacing, mergeSkipped warning, prune hint,
 * and API failure handling. GASFileOperations is mocked via sinon.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handlePushTool } from '../../src/tools/pushTool.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';

// Valid CommonJS module — passes all validation rules
const VALID_GS_CONTENT = `function _main() {
  exports.greet = function() { return 'hello'; };
}
__defineModule__(_main, false);
`;

// Invalid .gs — no _main, no __defineModule__ → triggers MISSING_MAIN + MISSING_DEFINE
const INVALID_GS_CONTENT = 'function badFunc() { return 1; }';

function makeFileOps(): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves([]),
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

describe('handlePushTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'push-'));
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Input validation ---

  it('returns error for invalid scriptId', async () => {
    const result = await handlePushTool({ scriptId: 'bad' }, makeFileOps());
    assert.equal(result.success, false);
    assert.deepEqual(result.filesPushed, []);
    assert.ok(result.error?.includes('Invalid scriptId'), `got: ${result.error}`);
  });

  it('returns error when localDir is outside home directory', async () => {
    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: '/etc/config' },
      makeFileOps(),
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes('home') || result.error?.includes('home directory'),
      `got: ${result.error}`,
    );
  });

  // --- Delegation to rsync ---

  it('successful push returns filesPushed and exec/deploy hint', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), VALID_GS_CONTENT, 'utf-8');

    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps(),
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.ok(result.filesPushed.length > 0, 'filesPushed should be non-empty');
    assert.ok(
      result.hints.next?.includes('exec') || result.hints.next?.includes('deploy'),
      `hint should mention exec or deploy, got: ${result.hints.next}`,
    );
  });

  it('dryRun returns file names without calling updateProjectFiles', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), VALID_GS_CONTENT, 'utf-8');
    const fileOps = makeFileOps();

    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, dryRun: true },
      fileOps,
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.ok(result.filesPushed.length > 0, 'filesPushed should list files even in dryRun');
    assert.equal(
      (fileOps.updateProjectFiles as sinon.SinonStub).callCount,
      0,
      'updateProjectFiles must not be called in dryRun',
    );
    assert.ok(
      result.hints.next?.includes('dryRun'),
      `hint should mention dryRun, got: ${result.hints.next}`,
    );
  });

  it('validation errors are surfaced with commonjs hint', async () => {
    await fs.writeFile(path.join(tmpDir, 'bad.gs'), INVALID_GS_CONTENT, 'utf-8');

    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps(),
    );

    assert.equal(result.success, false);
    assert.ok(
      result.validationErrors && result.validationErrors.length > 0,
      'validationErrors should be populated',
    );
    assert.ok(result.hints.commonjs, 'hints.commonjs should be present');
  });

  it('mergeSkipped warning present when getProjectFiles rejects', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), VALID_GS_CONTENT, 'utf-8');
    const fileOps = {
      getProjectFiles: sinon.stub().rejects(new Error('network error')),
      updateProjectFiles: sinon.stub().resolves([]),
    } as unknown as GASFileOperations;

    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      fileOps,
    );

    assert.equal(result.success, true, 'push should succeed even when remote fetch fails');
    assert.ok(
      result.hints.warning?.toLowerCase().includes('remote files could not be fetched'),
      `hints.warning should mention remote fetch failure, got: ${result.hints.warning}`,
    );
  });

  // --- Edge cases ---

  it('prune=true adds pruned note to hint', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), VALID_GS_CONTENT, 'utf-8');

    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, prune: true },
      makeFileOps(),
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.ok(
      result.hints.next?.includes('pruned'),
      `hint should mention pruned, got: ${result.hints.next}`,
    );
  });

  it('no valid GAS files in local directory returns failure with empty filesPushed', async () => {
    // tmpDir is empty — no .gs/.html/.json files → rsync returns "no local files" error
    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      makeFileOps(),
    );

    assert.equal(result.success, false);
    assert.deepEqual(result.filesPushed, []);
  });

  it('updateProjectFiles API failure returns error with authentication hint', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), VALID_GS_CONTENT, 'utf-8');
    const fileOps = {
      getProjectFiles: sinon.stub().resolves([]),
      updateProjectFiles: sinon.stub().rejects(new Error('401 Unauthorized')),
    } as unknown as GASFileOperations;

    const result = await handlePushTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir },
      fileOps,
    );

    assert.equal(result.success, false);
    assert.ok(
      result.hints.fix?.toLowerCase().includes('authentication') ||
      result.hints.fix?.toLowerCase().includes('auth'),
      `hint should mention authentication, got: ${result.hints.fix}`,
    );
  });
});
