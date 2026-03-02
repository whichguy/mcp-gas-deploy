/**
 * Unit tests for simplified rsync logic
 *
 * Tests getStatus (name + content-hash classification), push (prune flag),
 * and pull (no .gas-sync-state.json written).
 *
 * GAS API calls and fs operations are mocked via sinon so tests run without
 * live credentials and have no ordering dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStatus, push, pull } from '../../src/sync/rsync.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASFile } from '../../src/api/gasTypes.js';

// --- Helpers ---

function makeFileOps(remoteFiles: GASFile[]): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves(remoteFiles),
    updateProjectFiles: sinon.stub().resolves(remoteFiles),
  } as unknown as GASFileOperations;
}

function gasFile(name: string, source = `// ${name}`, type: GASFile['type'] = 'SERVER_JS'): GASFile {
  return { name, source, type };
}

// --- getStatus ---

describe('getStatus', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('classifies files with identical content as both', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), '// main', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.both.map(f => f.name), ['main']);
    assert.deepEqual(status.localOnly, []);
    assert.deepEqual(status.remoteOnly, []);
    assert.deepEqual(status.modified, []);
  });

  it('classifies files with different content as modified', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), '// updated locally', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// original on remote')]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.modified.map(f => f.name), ['main']);
    assert.deepEqual(status.both, []);
    assert.deepEqual(status.localOnly, []);
    assert.deepEqual(status.remoteOnly, []);
  });

  it('treats CRLF and LF as equivalent content (no spurious modified)', async () => {
    // Write local file with LF
    await fs.writeFile(path.join(tmpDir, 'main.gs'), 'line1\nline2', 'utf-8');
    // Remote has CRLF — GAS may normalize line endings
    const fileOps = makeFileOps([gasFile('main', 'line1\r\nline2')]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.both.map(f => f.name), ['main'], 'CRLF vs LF should not produce a spurious modified');
    assert.deepEqual(status.modified, []);
  });

  it('classifies files only in local dir as localOnly', async () => {
    await fs.writeFile(path.join(tmpDir, 'localOnly.gs'), '// local', 'utf-8');
    const fileOps = makeFileOps([]); // empty remote

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.localOnly.map(f => f.name), ['localOnly']);
    assert.deepEqual(status.both, []);
    assert.deepEqual(status.remoteOnly, []);
    assert.deepEqual(status.modified, []);
  });

  it('classifies files only on remote as remoteOnly', async () => {
    // localDir is empty
    const fileOps = makeFileOps([gasFile('remoteOnly')]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.remoteOnly.map(f => f.name), ['remoteOnly']);
    assert.deepEqual(status.both, []);
    assert.deepEqual(status.localOnly, []);
    assert.deepEqual(status.modified, []);
  });

  it('returns all remoteOnly when localDir does not exist', async () => {
    const nonExistent = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
    const fileOps = makeFileOps([gasFile('alpha'), gasFile('beta')]);

    const status = await getStatus('scriptId', nonExistent, fileOps);

    assert.equal(status.remoteOnly.length, 2);
    assert.deepEqual(status.localOnly, []);
    assert.deepEqual(status.both, []);
    assert.deepEqual(status.modified, []);
  });

  it('handles mixed classification correctly', async () => {
    await fs.writeFile(path.join(tmpDir, 'shared.gs'), '// shared', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'localOnly.gs'), '// local only', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'changed.gs'), '// changed locally', 'utf-8');
    const fileOps = makeFileOps([
      gasFile('shared', '// shared'),
      gasFile('remoteOnly'),
      gasFile('changed', '// original'),
    ]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.both.map(f => f.name), ['shared']);
    assert.deepEqual(status.localOnly.map(f => f.name), ['localOnly']);
    assert.deepEqual(status.remoteOnly.map(f => f.name), ['remoteOnly']);
    assert.deepEqual(status.modified.map(f => f.name), ['changed']);
  });

  it('excludes gas-deploy.json from local files', async () => {
    await fs.writeFile(path.join(tmpDir, 'gas-deploy.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'main.gs'), '// main', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.both.map(f => f.name), ['main']);
    assert.deepEqual(status.localOnly, []);
  });

  it('excludes hidden files (e.g. .gas-sync-state.json) from local files', async () => {
    await fs.writeFile(path.join(tmpDir, '.gas-sync-state.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'main.gs'), '// main', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.deepEqual(status.both.map(f => f.name), ['main']);
    assert.deepEqual(status.localOnly, []);
  });
});

// --- push ---

describe('push', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-push-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pushes all local files unconditionally', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'a.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'b.gs'), validGs, 'utf-8');

    const fileOps = makeFileOps([]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    assert.equal(result.filesPushed.length, 2);
    assert.ok(result.filesPushed.includes('a'));
    assert.ok(result.filesPushed.includes('b'));
    sinon.assert.calledOnce(fileOps.updateProjectFiles as sinon.SinonStub);
  });

  it('sends ALL local files even when remote already has them (merge behavior)', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'existing.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'new.gs'), validGs, 'utf-8');

    // Remote already has 'existing' — push should send both anyway
    const fileOps = makeFileOps([gasFile('existing', validGs)]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    assert.equal(result.filesPushed.length, 2);
    // updateProjectFiles should be called once with both files
    sinon.assert.calledOnce(fileOps.updateProjectFiles as sinon.SinonStub);
    const pushedFiles = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(pushedFiles.length, 2);
  });

  it('preserves remote-only files by default (prune=false merge behavior)', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    // Remote has 'local' (matched) and 'ghost' (remote-only)
    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    // filesPushed only counts local files
    assert.deepEqual(result.filesPushed, ['local']);
    // But updateProjectFiles should receive both local + remote-only files
    const pushedFiles = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(pushedFiles.length, 2, 'remote-only file should be preserved in payload');
    const names = pushedFiles.map(f => f.name);
    assert.ok(names.includes('ghost'), 'ghost remote-only file should be included');
  });

  it('removes remote-only files when prune=true', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    // Remote has 'local' + 'ghost' (remote-only)
    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true, prune: true });

    assert.ok(result.success);
    // With prune=true, updateProjectFiles should only receive local files
    const pushedFiles = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(pushedFiles.length, 1, 'remote-only file should be pruned');
    assert.equal(pushedFiles[0].name, 'local');
  });

  it('returns error when localDir has no .gs/.html/.json files', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'hello', 'utf-8');
    const fileOps = makeFileOps([]);

    const result = await push('scriptId', tmpDir, fileOps);

    assert.ok(!result.success);
    assert.ok(result.error?.includes('No .gs/.html/.json files'));
    sinon.assert.notCalled(fileOps.updateProjectFiles as sinon.SinonStub);
  });

  it('validates all .gs files before pushing', async () => {
    // Invalid CommonJS — missing __defineModule__
    await fs.writeFile(path.join(tmpDir, 'invalid.gs'), 'function foo() {}', 'utf-8');
    const fileOps = makeFileOps([]);

    const result = await push('scriptId', tmpDir, fileOps);

    assert.ok(!result.success);
    assert.ok(result.validationErrors && result.validationErrors.length > 0);
    sinon.assert.notCalled(fileOps.updateProjectFiles as sinon.SinonStub);
  });

  it('dry run returns file names without calling updateProjectFiles', async () => {
    await fs.writeFile(path.join(tmpDir, 'myFile.gs'), '// content', 'utf-8');
    const fileOps = makeFileOps([]);

    const result = await push('scriptId', tmpDir, fileOps, { dryRun: true });

    assert.ok(result.success);
    assert.ok(result.filesPushed.includes('myFile'));
    sinon.assert.notCalled(fileOps.updateProjectFiles as sinon.SinonStub);
  });

  it('sets mergeSkipped=true when remote fetch fails in merge mode', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    const fileOps = {
      getProjectFiles: sinon.stub().rejects(new Error('network error')),
      updateProjectFiles: sinon.stub().resolves([]),
    } as unknown as GASFileOperations;

    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success, 'push should still succeed');
    assert.equal(result.mergeSkipped, true, 'mergeSkipped should be true when remote fetch fails');
  });

  it('mergeSkipped is falsy when merge succeeds', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    const fileOps = makeFileOps([gasFile('remote', '// remote')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    assert.ok(!result.mergeSkipped, 'mergeSkipped should be falsy when merge succeeds');
  });

  it('mergeSkipped is falsy when prune=true (no merge attempted)', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    const fileOps = makeFileOps([gasFile('remote', '// remote')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true, prune: true });

    assert.ok(result.success);
    assert.ok(!result.mergeSkipped, 'mergeSkipped should be falsy when prune=true (no merge)');
  });

  it('sorts require.gs to position 0', async () => {
    const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'zzz.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'require.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'aaa.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    const pushedFiles = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(pushedFiles[0].name, 'require');
  });
});

// --- pull ---

describe('pull', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-pull-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes remote files to localDir', async () => {
    const fileOps = makeFileOps([
      gasFile('main', '// main content'),
      { name: 'appsscript', source: '{}', type: 'JSON' },
    ]);

    const result = await pull('scriptId', tmpDir, fileOps);

    assert.ok(result.success);
    assert.equal(result.filesPulled.length, 2);
    const mainContent = await fs.readFile(path.join(tmpDir, 'main.gs'), 'utf-8');
    assert.equal(mainContent, '// main content');
  });

  it('does not write .gas-sync-state.json to localDir', async () => {
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    await pull('scriptId', tmpDir, fileOps);

    const stateFilePath = path.join(tmpDir, '.gas-sync-state.json');
    await assert.rejects(
      () => fs.access(stateFilePath),
      { code: 'ENOENT' },
      '.gas-sync-state.json should not exist after pull'
    );
  });

  it('deletes orphaned .gas-sync-state.json if it exists from a previous version', async () => {
    // Simulate old state file left by pre-simplification version
    const stateFilePath = path.join(tmpDir, '.gas-sync-state.json');
    await fs.writeFile(stateFilePath, '{"main":"abc123"}', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    await pull('scriptId', tmpDir, fileOps);

    await assert.rejects(
      () => fs.access(stateFilePath),
      { code: 'ENOENT' },
      'Orphaned .gas-sync-state.json should be deleted by pull'
    );
  });

  it('creates localDir if it does not exist', async () => {
    const newDir = path.join(tmpDir, 'new-project');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    const result = await pull('scriptId', newDir, fileOps);

    assert.ok(result.success);
    const stat = await fs.stat(newDir);
    assert.ok(stat.isDirectory());
  });
});
