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

  it('loadNow files sorted to end of push payload', async () => {
    const loadNowGs = `function _main() { exports.h = function() {}; }\n__defineModule__(_main, true);`;
    const regularGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    await fs.writeFile(path.join(tmpDir, 'triggers.gs'), loadNowGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'utils.gs'), regularGs, 'utf-8');
    const fileOps = makeFileOps([]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    const pushed = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(pushed.length, 2, 'both files must be present in push payload');
    assert.equal(pushed[0].name, 'utils', 'regular file must be first');
    assert.equal(pushed[pushed.length - 1].name, 'triggers', 'loadNow file must be last in push payload');
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

  it('root-level new files append after folder-prefixed new files', () => {
    const fileSet: GASFile[] = [
      gasFile('common-js/foo'), gasFile('utils/bar'), gasFile('rootHelper'), gasFile('anotherRoot'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);

    const names = result.map(f => f.name);
    const folderPrefixedIndices = names.filter(n => n.includes('/')).map(n => names.indexOf(n));
    const rootIndices = names.filter(n => !n.includes('/')).map(n => names.indexOf(n));
    assert.ok(Math.max(...folderPrefixedIndices) < Math.min(...rootIndices),
      `Root-level files should come after folder-prefixed files, got: ${names}`);
    // Root-level files preserve insertion order
    assert.equal(names.indexOf('rootHelper'), names.indexOf('anotherRoot') - 1,
      `Root-level files should preserve insertion order, got: ${names}`);
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

  // --- Critical infrastructure pinning ---

  it('ConfigManager before __mcp_exec on first push (empty remote)', () => {
    const fileSet: GASFile[] = [
      gasFile('common-js/__mcp_exec'),
      gasFile('common-js/ConfigManager'),
      gasFile('main'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    assert.ok(
      names.indexOf('common-js/ConfigManager') < names.indexOf('common-js/__mcp_exec'),
      `ConfigManager must precede __mcp_exec, got: ${names}`
    );
  });

  it('critical trio (require, ConfigManager, __mcp_exec) at positions 0, 1, 2 on first push', () => {
    const fileSet: GASFile[] = [
      gasFile('main'),
      gasFile('common-js/__mcp_exec'),
      gasFile('common-js/utils'),
      gasFile('common-js/ConfigManager'),
      gasFile('common-js/require'),
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    assert.equal(names[0], 'common-js/require', `pos 0 must be require, got: ${names}`);
    assert.equal(names[1], 'common-js/ConfigManager', `pos 1 must be ConfigManager, got: ${names}`);
    assert.equal(names[2], 'common-js/__mcp_exec', `pos 2 must be __mcp_exec, got: ${names}`);
  });

  // --- loadNow sorting ---

  it('loadNow files (boolean form) sorted to end before manifest', () => {
    const loadNowSrc = `function _main() { exports.handler = function() {}; }\n__defineModule__(_main, true);`;
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    const fileSet: GASFile[] = [
      { name: 'triggers', source: loadNowSrc, type: 'SERVER_JS' },
      { name: 'utils', source: regularSrc, type: 'SERVER_JS' },
      { name: 'main', source: regularSrc, type: 'SERVER_JS' },
      { name: 'appsscript', source: '{}', type: 'JSON' },
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    assert.equal(names[names.length - 1], 'appsscript', 'appsscript must be last');
    assert.equal(names[names.length - 2], 'triggers', 'loadNow file must be just before manifest');
    assert.ok(names.indexOf('utils') < names.indexOf('triggers'), `utils must precede triggers, got: ${names}`);
    assert.ok(names.indexOf('main') < names.indexOf('triggers'), `main must precede triggers, got: ${names}`);
  });

  it('loadNow files (object form) also detected and sorted to end', () => {
    const loadNowSrc = `function _main() { exports.doGet = function() {}; }\n__defineModule__(_main, { loadNow: true });`;
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    const fileSet: GASFile[] = [
      { name: 'doGet', source: loadNowSrc, type: 'SERVER_JS' },
      { name: 'utils', source: regularSrc, type: 'SERVER_JS' },
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    assert.ok(names.indexOf('utils') < names.indexOf('doGet'), `utils must precede doGet (loadNow), got: ${names}`);
  });

  it('known loadNow file still moves to end despite lower remote position', () => {
    const loadNowSrc = `function _main() { exports.onOpen = function() {}; }\n__defineModule__(_main, true);`;
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    const fileSet: GASFile[] = [
      { name: 'events', source: loadNowSrc, type: 'SERVER_JS' },
      { name: 'utils', source: regularSrc, type: 'SERVER_JS' },
    ];
    // events is "known" with remote position 0 (lower than utils at 1)
    const remote = [
      gasFileWithPosition('events', 0),
      gasFileWithPosition('utils', 1),
    ];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    assert.ok(names.indexOf('utils') < names.indexOf('events'), `utils must precede events (loadNow), got: ${names}`);
  });

  it('multiple loadNow files preserve their relative order at end', () => {
    const loadNowSrc = (label: string) =>
      `function _main() { exports.${label} = function() {}; }\n__defineModule__(_main, true);`;
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    const fileSet: GASFile[] = [
      { name: 'main', source: regularSrc, type: 'SERVER_JS' },
      { name: 'onOpen', source: loadNowSrc('onOpen'), type: 'SERVER_JS' },
      { name: 'doGet', source: loadNowSrc('doGet'), type: 'SERVER_JS' },
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    assert.equal(names[0], 'main', `main must be first, got: ${names}`);
    // Both loadNow files must appear after main
    assert.ok(names.indexOf('main') < names.indexOf('onOpen'), `main must precede onOpen, got: ${names}`);
    assert.ok(names.indexOf('main') < names.indexOf('doGet'), `main must precede doGet, got: ${names}`);
    // Relative order of loadNow files preserved
    assert.ok(names.indexOf('onOpen') < names.indexOf('doGet'), `onOpen must precede doGet (insertion order), got: ${names}`);
  });

  it('non-loadNow files preserve relative order when loadNow files are extracted', () => {
    const loadNowSrc = `function _main() { exports.trigger = function() {}; }\n__defineModule__(_main, true);`;
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    const fileSet: GASFile[] = [
      { name: 'alpha', source: regularSrc, type: 'SERVER_JS' },
      { name: 'events', source: loadNowSrc, type: 'SERVER_JS' },
      { name: 'beta', source: regularSrc, type: 'SERVER_JS' },
      { name: 'gamma', source: regularSrc, type: 'SERVER_JS' },
    ];
    const remote: GASFile[] = [];

    const result = orderFilesForPush(fileSet, remote);
    const names = result.map(f => f.name);

    // Non-loadNow files keep relative order: alpha, beta, gamma
    assert.ok(names.indexOf('alpha') < names.indexOf('beta'), `alpha before beta, got: ${names}`);
    assert.ok(names.indexOf('beta') < names.indexOf('gamma'), `beta before gamma, got: ${names}`);
    // All before loadNow
    assert.ok(names.indexOf('gamma') < names.indexOf('events'), `gamma before events (loadNow), got: ${names}`);
  });

  it('require re-pinned to position 0 when remote position has drifted', () => {
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    // Remote has main at pos 0, require at pos 1 (drifted from expected position 0)
    const fileSet: GASFile[] = [
      { name: 'main', source: regularSrc, type: 'SERVER_JS' },
      { name: 'require', source: regularSrc, type: 'SERVER_JS' },
    ];
    const remote: GASFile[] = [
      { name: 'main', source: regularSrc, type: 'SERVER_JS', position: 0 },
      { name: 'require', source: regularSrc, type: 'SERVER_JS', position: 1 },
    ];

    const result = orderFilesForPush(fileSet, remote);
    assert.equal(result.length, 2, 'both files must be present');
    assert.equal(result[0].name, 'require', `require must be first even when remote position has drifted, got: ${result.map(f => f.name)}`);
    assert.equal(result[1].name, 'main', 'main must be second');
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

  it('returns error when localDir does not exist', async () => {
    const newDir = path.join(tmpDir, 'non-existent');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    const result = await pull('scriptId', newDir, fileOps);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('does not exist'), `expected dir-not-exist error, got: ${result.error}`);
  });
});

// --- push — extra files on either side ---

describe('push — extra files on either side', () => {
  let tmpDir: string;
  const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-push-extra-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  it('merge sends remote-only files with full object fields', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs), gasFile('ghost', '// ghost-content')]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    const payload = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    const ghost = payload.find(f => f.name === 'ghost');
    assert.ok(ghost, 'ghost should be in payload');
    assert.equal(ghost!.source, '// ghost-content');
    assert.equal(ghost!.type, 'SERVER_JS');
  });

  it('merge with extras on both sides sends all three files', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'new-local.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs), gasFile('ghost', '// ghost')]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    const payload = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(payload.length, 3);
    const names = payload.map(f => f.name);
    assert.ok(names.includes('main'));
    assert.ok(names.includes('new-local'));
    assert.ok(names.includes('ghost'));
  });

  it('prune excludes remote-only from payload', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs), gasFile('ghost', '// ghost')]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true, prune: true });

    const payload = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(payload.length, 1);
    assert.equal(payload[0].name, 'main');
    assert.ok(!payload.find(f => f.name === 'ghost'), 'ghost should not be in pruned payload');
  });

  it('prune with extras on both sides sends only local files', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'new-local.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs), gasFile('ghost', '// ghost')]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true, prune: true });

    const payload = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    assert.equal(payload.length, 2);
    const names = payload.map(f => f.name);
    assert.ok(names.includes('main'));
    assert.ok(names.includes('new-local'));
    assert.ok(!names.includes('ghost'), 'ghost should not be in pruned payload');
  });

  it('merge preserves source content of remote-only files', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs), gasFile('config', '// config-marker')]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true });

    const payload = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];
    const config = payload.find(f => f.name === 'config');
    assert.ok(config, 'config should be in payload');
    assert.equal(config!.source, '// config-marker');
  });
});

// --- pull — interaction with existing local state ---

describe('pull — interaction with existing local state', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-pull-existing-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  it('pull overwrites diverged local file content', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), '// old content', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// new content')]);

    await pull('scriptId', tmpDir, fileOps);

    const content = await fs.readFile(path.join(tmpDir, 'main.gs'), 'utf-8');
    assert.equal(content, '// new content');
  });

  it('pull does not delete local-only files', async () => {
    await fs.writeFile(path.join(tmpDir, 'local-only.gs'), '// mine', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// main')]);

    await pull('scriptId', tmpDir, fileOps);

    const content = await fs.readFile(path.join(tmpDir, 'local-only.gs'), 'utf-8');
    assert.equal(content, '// mine');
  });

  it('pull overwrites existing and creates new remote files simultaneously', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing.gs'), '// old', 'utf-8');
    const fileOps = makeFileOps([
      gasFile('existing', '// updated'),
      gasFile('brand-new', '// brand-new-content'),
    ]);

    const result = await pull('scriptId', tmpDir, fileOps);

    const existing = await fs.readFile(path.join(tmpDir, 'existing.gs'), 'utf-8');
    assert.equal(existing, '// updated');
    const brandNew = await fs.readFile(path.join(tmpDir, 'brand-new.gs'), 'utf-8');
    assert.equal(brandNew, '// brand-new-content');
    assert.ok(result.filesPulled.includes('existing.gs'));
    assert.ok(result.filesPulled.includes('brand-new.gs'));
  });

  it('pull writes JSON file (appsscript) with .json extension', async () => {
    const fileOps = makeFileOps([{ name: 'appsscript', source: '{}', type: 'JSON' }]);

    await pull('scriptId', tmpDir, fileOps);

    const content = await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8');
    assert.equal(content, '{}');
    await assert.rejects(
      () => fs.access(path.join(tmpDir, 'appsscript.gs')),
      { code: 'ENOENT' },
      'appsscript.gs should not exist'
    );
  });
});

// --- status integration after sync ---

describe('status integration after sync', () => {
  let tmpDir: string;
  const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-status-integration-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  it('getStatus after merge push shows all files in-sync', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'new-local.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs), gasFile('ghost', validGs)]);

    await push('scriptId', tmpDir, fileOps, { skipValidation: true });
    const mergedPayload = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as GASFile[];

    (fileOps.getProjectFiles as sinon.SinonStub).resolves(mergedPayload);
    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.equal(status.localOnly.length, 0);
    assert.equal(status.remoteOnly.length, 1); // ghost was not written locally by merge push
    assert.equal(status.modified.length, 0);
    const bothNames = status.both.map(f => f.name);
    assert.ok(bothNames.includes('main'));
    assert.ok(bothNames.includes('new-local'));
  });

  it('getStatus after pull: remote synced, local-only preserved', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), '// old', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'local-only.gs'), '// mine', 'utf-8');
    const fileOps = makeFileOps([gasFile('main', '// updated'), gasFile('remote-new', validGs)]);

    await pull('scriptId', tmpDir, fileOps);
    const status = await getStatus('scriptId', tmpDir, fileOps);

    assert.equal(status.remoteOnly.length, 0);
    assert.equal(status.modified.length, 0);
    const bothNames = status.both.map(f => f.name);
    assert.ok(bothNames.includes('main'));
    assert.ok(bothNames.includes('remote-new'));
    const localOnlyNames = status.localOnly.map(f => f.name);
    assert.ok(localOnlyNames.includes('local-only'));
  });
});

// --- push preview (dryRun) ---

describe('push preview (dryRun)', () => {
  const SCRIPT_ID = 'previewTestId123456789';
  const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
  const updatedGs = `function _main() { exports.fn = function() { return 42; }; }\n__defineModule__(_main, false);`;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-preview-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  it('dryRun=true returns preview with correct buckets (toAdd/toUpdate/toPreserve/toPrune)', async () => {
    // local: main (same), updated (modified), newfile (add)
    // remote: main (same), updated (old), ghost (remoteOnly)
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'updated.gs'), updatedGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'newfile.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([
      gasFile('main', validGs),
      gasFile('updated', validGs), // old content — will be modified
      gasFile('ghost', validGs),   // remote-only
    ]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, skipValidation: true });

    assert.equal(result.success, true);
    assert.ok(result.preview, 'preview must be set on dryRun');
    assert.ok(result.preview.toAdd.includes('newfile'), `toAdd: ${result.preview.toAdd}`);
    assert.ok(result.preview.toUpdate.includes('updated'), `toUpdate: ${result.preview.toUpdate}`);
    assert.ok(result.preview.toPreserve.includes('ghost'), `toPreserve: ${result.preview.toPreserve}`);
    assert.equal(result.preview.toPrune.length, 0, 'toPrune should be empty when prune=false');
    assert.ok(!result.preview.toAdd.includes('main'), 'unchanged file should not be in toAdd');
    assert.ok(!result.preview.toUpdate.includes('main'), 'unchanged file should not be in toUpdate');
  });

  it('dryRun=true with prune=true: remote-only files appear in toPrune, not toPreserve', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([
      gasFile('main', validGs),
      gasFile('ghost', validGs),
    ]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, prune: true, skipValidation: true });

    assert.equal(result.success, true);
    assert.ok(result.preview, 'preview must be set');
    assert.ok(result.preview.toPrune.includes('ghost'), `toPrune: ${result.preview.toPrune}`);
    assert.equal(result.preview.toPreserve.length, 0, 'toPreserve should be empty when prune=true');
  });

  it('dryRun=true with prune=false: remote-only files appear in toPreserve, not toPrune', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([
      gasFile('main', validGs),
      gasFile('ghost', validGs),
    ]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, prune: false, skipValidation: true });

    assert.equal(result.success, true);
    assert.ok(result.preview, 'preview must be set');
    assert.ok(result.preview.toPreserve.includes('ghost'), `toPreserve: ${result.preview.toPreserve}`);
    assert.equal(result.preview.toPrune.length, 0, 'toPrune should be empty when prune=false');
  });

  it('totalFilesAfterPush is correct in merge mode (prune=false)', async () => {
    // 2 local + 1 remoteOnly (preserved) = 3 total
    await fs.writeFile(path.join(tmpDir, 'a.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'b.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([
      gasFile('a', validGs),
      gasFile('ghost', validGs),
    ]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, prune: false, skipValidation: true });

    assert.ok(result.preview, 'preview must be set');
    assert.equal(result.preview.totalFilesAfterPush, 3, 'local(2) + preserved(1) = 3');
  });

  it('totalFilesAfterPush is correct in prune mode (prune=true)', async () => {
    // 2 local + 1 remoteOnly (pruned, not counted) = 2 total
    await fs.writeFile(path.join(tmpDir, 'a.gs'), validGs, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'b.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([
      gasFile('a', validGs),
      gasFile('ghost', validGs),
    ]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, prune: true, skipValidation: true });

    assert.ok(result.preview, 'preview must be set');
    assert.equal(result.preview.totalFilesAfterPush, 2, 'local(2) only when prune=true');
  });

  it('dryRun=true does NOT call updateProjectFiles', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([gasFile('main', validGs)]);

    await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, skipValidation: true });

    assert.equal(
      (fileOps.updateProjectFiles as sinon.SinonStub).callCount,
      0,
      'updateProjectFiles must not be called in dryRun',
    );
  });

  it('dryRun=true when mergeSkipped: preview is set with empty remote buckets', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = {
      getProjectFiles: sinon.stub().rejects(new Error('network error')),
      updateProjectFiles: sinon.stub().resolves([]),
    } as unknown as GASFileOperations;

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { dryRun: true, skipValidation: true });

    assert.equal(result.success, true);
    assert.ok(result.mergeSkipped, 'mergeSkipped should be true');
    assert.ok(result.preview, 'preview must be set even when mergeSkipped');
    // With no remote data, remote buckets are empty
    assert.equal(result.preview.toPreserve.length, 0, 'no remote files to preserve');
    assert.equal(result.preview.toPrune.length, 0, 'no remote files to prune');
    // Local file is in toAdd (not found on remote)
    assert.ok(result.preview.toAdd.includes('main'), `toAdd should include main: ${result.preview.toAdd}`);
  });
});

// --- push no longer writes .clasp.json ---

describe('push — no ensureClaspFiles side effects', () => {
  const SCRIPT_ID = 'claspTestId123456789x';
  const validGs = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'clasp-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  it('.clasp.json NOT written after successful push', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { skipValidation: true });

    assert.equal(result.success, true);
    await assert.rejects(
      () => fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8'),
      { code: 'ENOENT' },
      '.clasp.json must not be written by push',
    );
  });

  it('.gitignore NOT written after successful push', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([]);

    await push(SCRIPT_ID, tmpDir, fileOps, { skipValidation: true });

    await assert.rejects(
      () => fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8'),
      { code: 'ENOENT' },
      '.gitignore must not be written by push',
    );
  });

  it('result does not include claspResult', async () => {
    await fs.writeFile(path.join(tmpDir, 'main.gs'), validGs, 'utf-8');
    const fileOps = makeFileOps([]);

    const result = await push(SCRIPT_ID, tmpDir, fileOps, { skipValidation: true });

    assert.equal(result.success, true);
    assert.equal((result as Record<string, unknown>).claspResult, undefined, 'claspResult should not be in result');
  });
});

// --- pull — double-extension guard ---

describe('pull — double-extension guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsync-dblext-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    sinon.restore();
  });

  it('file named "foo.gs" does not become "foo.gs.gs"', async () => {
    const fileOps = makeFileOps([
      { name: 'foo.gs', source: '// already has ext', type: 'SERVER_JS' },
    ]);

    const result = await pull('scriptId', tmpDir, fileOps);

    assert.ok(result.success);
    // Should be foo.gs, not foo.gs.gs
    assert.ok(result.filesPulled.includes('foo.gs'), `expected foo.gs, got: ${result.filesPulled}`);
    assert.ok(!result.filesPulled.includes('foo.gs.gs'), 'should NOT have double extension');
    const content = await fs.readFile(path.join(tmpDir, 'foo.gs'), 'utf-8');
    assert.equal(content, '// already has ext');
  });

  it('file named "utils" gets .gs extension added normally', async () => {
    const fileOps = makeFileOps([
      gasFile('utils', '// utils code'),
    ]);

    const result = await pull('scriptId', tmpDir, fileOps);

    assert.ok(result.success);
    assert.ok(result.filesPulled.includes('utils.gs'));
    const content = await fs.readFile(path.join(tmpDir, 'utils.gs'), 'utf-8');
    assert.equal(content, '// utils code');
  });

  it('HTML file named "sidebar.html" does not become "sidebar.html.html"', async () => {
    const fileOps = makeFileOps([
      { name: 'sidebar.html', source: '<html></html>', type: 'HTML' },
    ]);

    const result = await pull('scriptId', tmpDir, fileOps);

    assert.ok(result.success);
    assert.ok(result.filesPulled.includes('sidebar.html'), `expected sidebar.html, got: ${result.filesPulled}`);
    assert.ok(!result.filesPulled.includes('sidebar.html.html'), 'should NOT have double extension');
  });
});
