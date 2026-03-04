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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStatus, push, pull, orderFilesForPush } from '../../src/sync/rsync.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASFile } from '../../src/api/gasTypes.js';

const execFileAsync = promisify(execFile);

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

  it('sorts require.gs to position 0 via orderFilesForPush', async () => {
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

// --- orderFilesForPush ---

function gasFileWithPosition(name: string, position: number, type: GASFile['type'] = 'SERVER_JS'): GASFile {
  return { name, source: `// ${name}`, type, position };
}

describe('orderFilesForPush', () => {
  it('preserves remote order for existing files', () => {
    const fileSet: GASFile[] = [
      gasFile('beta'), gasFile('alpha'), gasFile('gamma'),
    ];
    const remote = [
      gasFileWithPosition('alpha', 0),
      gasFileWithPosition('beta', 1),
      gasFileWithPosition('gamma', 2),
    ];

    const result = orderFilesForPush(fileSet, remote);

    assert.deepEqual(result.map(f => f.name), ['alpha', 'beta', 'gamma']);
  });

  it('appends new files after existing files', () => {
    const fileSet: GASFile[] = [
      gasFile('existing'), gasFile('brandNew'),
    ];
    const remote = [gasFileWithPosition('existing', 0)];

    const result = orderFilesForPush(fileSet, remote);

    assert.equal(result[0].name, 'existing');
    assert.equal(result[1].name, 'brandNew');
  });

  it('new common-js/ files sort before other new files', () => {
    const fileSet: GASFile[] = [
      gasFile('ui/sidebar'), gasFile('common-js/utils'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);

    const names = result.map(f => f.name);
    assert.ok(
      names.indexOf('common-js/utils') < names.indexOf('ui/sidebar'),
      `common-js/utils should come before ui/sidebar, got: ${names}`
    );
  });

  it('new files grouped by folder', () => {
    const fileSet: GASFile[] = [
      gasFile('b/two'), gasFile('a/one'), gasFile('b/one'), gasFile('a/two'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);

    const names = result.map(f => f.name);
    // a/ files should be together, b/ files should be together
    const aIndices = names.filter(n => n.startsWith('a/')).map(n => names.indexOf(n));
    const bIndices = names.filter(n => n.startsWith('b/')).map(n => names.indexOf(n));
    assert.ok(Math.max(...aIndices) < Math.min(...bIndices) || Math.max(...bIndices) < Math.min(...aIndices),
      `Files should be grouped by folder, got: ${names}`);
  });

  it('appsscript manifest always last', () => {
    const fileSet: GASFile[] = [
      { name: 'appsscript', source: '{}', type: 'JSON' },
      gasFile('main'),
      gasFile('utils'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);

    assert.equal(result[result.length - 1].name, 'appsscript');
  });

  it('first push (empty remote) — common-js first, folder-grouped, appsscript last', () => {
    const fileSet: GASFile[] = [
      gasFile('ui/dialog'),
      gasFile('common-js/require'),
      { name: 'appsscript', source: '{}', type: 'JSON' },
      gasFile('main'),
      gasFile('common-js/utils'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);

    const names = result.map(f => f.name);
    // require first (Tier 0)
    assert.equal(names[0], 'common-js/require');
    // common-js/ files next (Tier 1)
    assert.ok(names.indexOf('common-js/utils') < names.indexOf('main'),
      `common-js/utils should be before main, got: ${names}`);
    // appsscript last
    assert.equal(names[names.length - 1], 'appsscript');
  });

  it('require.gs at position 0 when it exists on remote', () => {
    const fileSet: GASFile[] = [
      gasFile('main'), gasFile('require'),
    ];
    const remote = [
      gasFileWithPosition('require', 0),
      gasFileWithPosition('main', 1),
    ];

    const result = orderFilesForPush(fileSet, remote);

    assert.equal(result[0].name, 'require');
  });

  it('mixed known + new files across folders', () => {
    const fileSet: GASFile[] = [
      gasFile('newFile'),
      gasFile('existing-a'),
      gasFile('common-js/newModule'),
      gasFile('existing-b'),
    ];
    const remote = [
      gasFileWithPosition('existing-a', 2),
      gasFileWithPosition('existing-b', 5),
    ];

    const result = orderFilesForPush(fileSet, remote);

    const names = result.map(f => f.name);
    // Known files first in remote order
    assert.equal(names[0], 'existing-a');
    assert.equal(names[1], 'existing-b');
    // New common-js/ before other new
    assert.ok(names.indexOf('common-js/newModule') < names.indexOf('newFile'),
      `common-js/newModule should be before newFile, got: ${names}`);
  });

  it('empty fileSet returns empty array', () => {
    const result = orderFilesForPush([], [gasFileWithPosition('foo', 0)]);
    assert.deepEqual(result, []);
  });

  it('remote files without position field treated as high position', () => {
    const fileSet: GASFile[] = [
      gasFile('noPos'), gasFile('hasPos'),
    ];
    const remote: GASFile[] = [
      { name: 'hasPos', source: '// hasPos', type: 'SERVER_JS', position: 0 },
      { name: 'noPos', source: '// noPos', type: 'SERVER_JS' }, // no position field
    ];

    const result = orderFilesForPush(fileSet, remote);

    // hasPos (position 0) should come before noPos (MAX_SAFE_INTEGER fallback)
    assert.equal(result[0].name, 'hasPos');
    assert.equal(result[1].name, 'noPos');
  });

  it('stable order within same folder for new files', () => {
    const fileSet: GASFile[] = [
      gasFile('lib/alpha'), gasFile('lib/beta'), gasFile('lib/gamma'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);

    // Should preserve insertion order within same folder
    assert.deepEqual(result.map(f => f.name), ['lib/alpha', 'lib/beta', 'lib/gamma']);
  });
});

// --- push git archive ---

describe('push git archive', () => {
  let tmpDir: string;
  const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;

  async function initGit(dir: string): Promise<void> {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  }

  async function initGitCommit(dir: string): Promise<void> {
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  }

  async function gitLog(dir: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: dir });
    return stdout.trim();
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-archive-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('archives remote-only files in git with two commits', async () => {
    await initGit(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');
    await initGitCommit(tmpDir);

    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    assert.equal(result.gitArchived, true);
    assert.deepEqual(result.archivedFiles, ['ghost']);

    const log = await gitLog(tmpDir);
    assert.ok(log.includes('gas-archive:'), `Expected archive commits in log: ${log}`);
    assert.ok(log.includes('removed archived files'), `Expected removal commit in log: ${log}`);

    // Working tree should be restored — ghost.gs should not exist
    await assert.rejects(() => fs.access(path.join(tmpDir, 'ghost.gs')), 'ghost.gs should not exist after archive');
  });

  it('does not commit uncommitted local modifications during archive', async () => {
    await initGit(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');
    await initGitCommit(tmpDir);

    // Modify local.gs WITHOUT committing — simulates user's in-progress edit
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs + '\n// user edit', 'utf-8');

    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    assert.equal(result.gitArchived, true);

    // The user's uncommitted edit should still be unstaged (dirty working tree)
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
    assert.ok(status.includes('local.gs'), 'local.gs should still show as modified (uncommitted)');

    // Verify the local file content was not reverted
    const content = await fs.readFile(path.join(tmpDir, 'local.gs'), 'utf-8');
    assert.ok(content.includes('// user edit'), 'local modification should be preserved on disk');

    // Verify the archive commit itself did not include local.gs
    const { stdout: archiveDiff } = await execFileAsync('git', ['show', '--stat', 'HEAD~1'], { cwd: tmpDir });
    assert.ok(!archiveDiff.includes('local.gs'), 'archive commit should not contain local.gs (user edit was leaked)');
  });

  it('does not archive when no remote-only files', async () => {
    await initGit(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'shared.gs'), validGs, 'utf-8');
    await initGitCommit(tmpDir);

    const fileOps = makeFileOps([gasFile('shared', validGs)]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success);
    assert.ok(!result.gitArchived, 'gitArchived should be falsy when no remote-only files');
  });

  it('skips archive when no .git directory', async () => {
    // No git init — tmpDir has no .git
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success, 'push should still succeed without git');
    assert.ok(!result.gitArchived, 'gitArchived should be false without .git');
  });

  it('archives in prune mode too', async () => {
    await initGit(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');
    await initGitCommit(tmpDir);

    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// pruned')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true, prune: true });

    assert.ok(result.success);
    assert.equal(result.gitArchived, true, 'should archive even in prune mode');
    assert.deepEqual(result.archivedFiles, ['ghost']);

    // Verify ghost is NOT in the push payload (prune removes it)
    const pushedFiles = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.ok(!pushedFiles.find(f => f.name === 'ghost'), 'ghost should not be in push payload with prune=true');
  });

  it('push succeeds even if git archive fails', async () => {
    // Create .git dir but corrupt it so git commands fail
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');

    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    assert.ok(result.success, 'push should succeed even when git archive fails');
    assert.ok(!result.gitArchived, 'gitArchived should be false on git failure');
  });

  it('dryRun skips git archive', async () => {
    await initGit(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'local.gs'), validGs, 'utf-8');
    await initGitCommit(tmpDir);

    const fileOps = makeFileOps([gasFile('local', validGs), gasFile('ghost', '// remote only')]);
    const result = await push('scriptId', tmpDir, fileOps, { skipValidation: true, dryRun: true });

    assert.ok(result.success);
    assert.ok(!result.gitArchived, 'dryRun should skip git archive');

    // Only the initial commit should exist
    const log = await gitLog(tmpDir);
    assert.ok(!log.includes('gas-archive:'), 'No archive commits should exist on dryRun');
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
