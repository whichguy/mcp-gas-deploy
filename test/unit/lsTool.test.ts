/**
 * Unit tests for handleLsTool
 *
 * Tests input validation, path filtering (substring + regex), type filtering,
 * sort order, size field, error handling. GASFileOperations is mocked via sinon.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleLsTool } from '../../src/tools/lsTool.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASFile } from '../../src/api/gasTypes.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';

function makeFileOps(files: GASFile[]): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves(files),
    updateProjectFiles: sinon.stub().resolves(files),
  } as unknown as GASFileOperations;
}

function gasFile(name: string, opts: Partial<GASFile> = {}): GASFile {
  return {
    name,
    type: 'SERVER_JS',
    source: `// ${name} source`,
    position: 0,
    ...opts,
  };
}

describe('handleLsTool', () => {
  afterEach(() => {
    sinon.restore();
  });

  // --- Input validation ---

  it('returns error for invalid scriptId', async () => {
    const result = await handleLsTool(
      { scriptId: 'bad' },
      makeFileOps([]),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid scriptId'), `got: ${result.error}`);
  });

  // --- Basic listing ---

  it('returns all files with metadata and no source', async () => {
    const files = [
      gasFile('main', { position: 0, createTime: '2024-01-01', updateTime: '2024-06-01' }),
      gasFile('utils', { position: 1, type: 'SERVER_JS' }),
    ];
    const fileOps = makeFileOps(files);

    const result = await handleLsTool({ scriptId: VALID_SCRIPT_ID }, fileOps);

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.scriptId, VALID_SCRIPT_ID);
    assert.equal(result.files![0].name, 'main');
    assert.equal(result.files![1].name, 'utils');
    // No source in output
    for (const f of result.files!) {
      assert.equal((f as Record<string, unknown>).source, undefined, 'source should not be in output');
    }
  });

  // --- Type filter ---

  it('filters by type when type param is provided', async () => {
    const files = [
      gasFile('script', { type: 'SERVER_JS', position: 0 }),
      gasFile('page', { type: 'HTML', position: 1 }),
      gasFile('manifest', { type: 'JSON', position: 2 }),
    ];
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID, type: 'SERVER_JS' },
      makeFileOps(files),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.files![0].name, 'script');
  });

  // --- Path substring filter ---

  it('filters by path substring (case-insensitive)', async () => {
    const files = [
      gasFile('common-js/utils', { position: 0 }),
      gasFile('main', { position: 1 }),
      gasFile('common-js/helpers', { position: 2 }),
    ];
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID, path: 'utils' },
      makeFileOps(files),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.files![0].name, 'common-js/utils');
  });

  // --- Path regex filter ---

  it('uses regex matching when path contains metacharacters', async () => {
    const files = [
      gasFile('common-js/utils', { position: 0 }),
      gasFile('common-js/helpers', { position: 1 }),
      gasFile('main', { position: 2 }),
    ];
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID, path: '^common-js/' },
      makeFileOps(files),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.ok(result.files!.every((f) => f.name.startsWith('common-js/')));
  });

  // --- Invalid regex ---

  it('returns error for invalid regex in path', async () => {
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID, path: '[invalid' },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid regex'), `got: ${result.error}`);
    assert.ok(result.hints.fix, 'should have a fix hint');
  });

  // --- Long regex rejected (ReDoS defense) ---

  it('rejects path longer than 200 characters', async () => {
    const longPath = 'a'.repeat(201);
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID, path: longPath },
      makeFileOps([gasFile('main')]),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('too long'), `got: ${result.error}`);
  });

  // --- Empty project ---

  it('returns empty array for project with no files', async () => {
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps([]),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.files, []);
  });

  // --- Size field ---

  it('size equals source.length', async () => {
    const source = '// hello world';
    const files = [gasFile('main', { source, position: 0 })];
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps(files),
    );

    assert.equal(result.success, true);
    assert.equal(result.files![0].size, source.length);
  });

  // --- Sort order ---

  it('sorts files by position (nullish last)', async () => {
    const files = [
      gasFile('c', { position: 2 }),
      gasFile('a', { position: 0 }),
      gasFile('z', { position: undefined }),
      gasFile('b', { position: 1 }),
    ];
    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps(files),
    );

    assert.equal(result.success, true);
    assert.deepEqual(
      result.files!.map((f) => f.name),
      ['a', 'b', 'c', 'z'],
    );
  });

  // --- Error handling ---

  it('returns error with auth hint on API failure', async () => {
    const fileOps = {
      getProjectFiles: sinon.stub().rejects(new Error('401 Unauthorized')),
      updateProjectFiles: sinon.stub().resolves([]),
    } as unknown as GASFileOperations;

    const result = await handleLsTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('401'), `got: ${result.error}`);
    assert.ok(result.hints.fix?.includes('auth'), `hint should mention auth, got: ${result.hints.fix}`);
  });

  // --- .clasp.json resolution ---

  describe('.clasp.json resolution', () => {
    let tmpDir: string;

    beforeEach(async () => {
      const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
      await fs.mkdir(base, { recursive: true });
      tmpDir = await fs.mkdtemp(path.join(base, 'ls-clasp-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('reads scriptId from .clasp.json when scriptId is omitted', async () => {
      await fs.writeFile(
        path.join(tmpDir, '.clasp.json'),
        JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
        'utf-8'
      );

      const result = await handleLsTool(
        { localDir: tmpDir },
        makeFileOps([gasFile('main')]),
      );

      assert.equal(result.success, true);
      assert.equal(result.count, 1);
    });

    it('returns error when neither scriptId nor .clasp.json is available', async () => {
      const result = await handleLsTool(
        { localDir: tmpDir },
        makeFileOps([]),
      );

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('No scriptId provided'), `got: ${result.error}`);
    });
  });
});
