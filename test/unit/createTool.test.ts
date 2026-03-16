/**
 * Unit tests for handleCreateTool
 *
 * Tests: missing title, successful create, API failure, partial failure recovery,
 * localDir already exists, localDir doesn't exist (creates it), path traversal guard,
 * runtime files, manifest construction, push integration.
 */

import { describe, it, beforeEach, afterEach, after } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleCreateTool, RUNTIME_DIR, RUNTIME_FILES, type PushFn } from '../../src/tools/createTool.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { PushResult } from '../../src/sync/rsync.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';

function makeProjectOps(scriptId: string = VALID_SCRIPT_ID): GASProjectOperations {
  return {
    createProject: sinon.stub().resolves({ scriptId, title: 'Test Project' }),
    listProjects: sinon.stub().resolves([]),
    getProjectTitle: sinon.stub().resolves('Test Project'),
    trashProject: sinon.stub().resolves(),
  } as unknown as GASProjectOperations;
}

function makeFileOps(): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves([]),
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

/**
 * Ensure runtime files exist in the real RUNTIME_DIR.
 * They should already be present from npm run sync-runtime,
 * but create stubs if missing (e.g. CI).
 */
async function ensureStubRuntimeFiles(): Promise<void> {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  for (const file of RUNTIME_FILES) {
    const filePath = path.join(RUNTIME_DIR, file.src);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, `// stub: ${file.src}\n`, 'utf-8');
    }
  }
}

const DEFAULT_PUSH_RESULT: PushResult = {
  success: true,
  filesPushed: [
    'require', 'common-js/ConfigManager', 'common-js/__mcp_exec',
    'common-js/html_utils', 'appsscript',
  ],
};

function makePushFn(result: PushResult = DEFAULT_PUSH_RESULT): PushFn & sinon.SinonStub {
  return sinon.stub().resolves(result) as PushFn & sinon.SinonStub;
}

describe('handleCreateTool', () => {
  let tmpDir: string;
  let pushFn: PushFn & sinon.SinonStub;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'create-'));

    await ensureStubRuntimeFiles();
    pushFn = makePushFn();
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Input validation ---

  it('returns error when title is missing', async () => {
    const result = await handleCreateTool(
      { title: '' },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('title is required'), `got: ${result.error}`);
  });

  it('returns error when title is whitespace only', async () => {
    const result = await handleCreateTool(
      { title: '   ' },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('title is required'), `got: ${result.error}`);
  });

  // --- Path traversal ---

  it('returns error when localDir is outside home directory', async () => {
    const result = await handleCreateTool(
      { title: 'Test', localDir: '/etc/config' },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('home directory'), `got: ${result.error}`);
  });

  // --- Successful create ---

  it('successful create returns scriptId, title, localDir, runtimeIncluded, and filesPushed', async () => {
    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.equal(result.scriptId, VALID_SCRIPT_ID);
    assert.equal(result.title, 'Test Project');
    assert.equal(result.localDir, tmpDir);
    assert.equal(result.runtimeIncluded, true);
    assert.ok(Array.isArray(result.filesPushed), 'filesPushed should be an array');
    assert.ok(result.filesPushed!.length > 0, 'filesPushed should not be empty');
  });

  // --- Manifest construction ---

  it('builds manifest with webapp and scopes defaults', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const manifestContent = await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8');
    const manifest = JSON.parse(manifestContent);
    assert.equal(manifest.runtimeVersion, 'V8');
    assert.equal(manifest.timeZone, 'America/New_York');
    assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
    assert.equal(manifest.webapp.access, 'MYSELF');
    assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
    assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'));
    assert.deepEqual(manifest.executionApi, { access: 'MYSELF' }, 'executionApi should be set for scripts.run');
  });

  it('merges custom oauthScopes (deduped)', async () => {
    const customScope = 'https://www.googleapis.com/auth/spreadsheets';
    const duplicateScope = 'https://www.googleapis.com/auth/script.scriptapp';
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir, oauthScopes: [customScope, duplicateScope] },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const manifestContent = await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8');
    const manifest = JSON.parse(manifestContent);
    assert.ok(manifest.oauthScopes.includes(customScope), 'custom scope should be included');
    const scriptappCount = manifest.oauthScopes.filter(
      (s: string) => s === duplicateScope
    ).length;
    assert.equal(scriptappCount, 1, 'duplicate scope should not be added twice');
  });

  it('applies custom webapp overrides', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir, webapp: { executeAs: 'USER_ACCESSING', access: 'ANYONE' } },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const manifestContent = await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8');
    const manifest = JSON.parse(manifestContent);
    assert.equal(manifest.webapp.executeAs, 'USER_ACCESSING');
    assert.equal(manifest.webapp.access, 'ANYONE');
  });

  it('applies partial webapp override (executeAs only, access defaults to MYSELF)', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir, webapp: { executeAs: 'USER_ACCESSING' } },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8'));
    assert.equal(manifest.webapp.executeAs, 'USER_ACCESSING');
    assert.equal(manifest.webapp.access, 'MYSELF');
  });

  it('applies partial webapp override (access only, executeAs defaults to USER_DEPLOYING)', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir, webapp: { access: 'ANYONE' } },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8'));
    assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
    assert.equal(manifest.webapp.access, 'ANYONE');
  });

  // --- Runtime file placement ---

  it('copies require.gs to root and runtime files to common-js/', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    // require.gs at root
    const requireStat = await fs.stat(path.join(tmpDir, 'require.gs'));
    assert.ok(requireStat.isFile(), 'require.gs should exist at root');

    // common-js/ files
    for (const file of RUNTIME_FILES) {
      const filePath = path.join(tmpDir, file.dest);
      const stat = await fs.stat(filePath);
      assert.ok(stat.isFile(), `${file.dest} should exist`);
    }
  });

  it('creates common-js/ directory automatically', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const stat = await fs.stat(path.join(tmpDir, 'common-js'));
    assert.ok(stat.isDirectory(), 'common-js/ should be created');
  });

  // --- Push integration ---

  it('calls push with correct scriptId, localDir, fileOps, and prune:true', async () => {
    const fileOps = makeFileOps();
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      fileOps,
      pushFn,
    );

    assert.equal(pushFn.callCount, 1, 'push should be called once');
    const [scriptIdArg, localDirArg, fileOpsArg, optionsArg] = pushFn.firstCall.args;
    assert.equal(scriptIdArg, VALID_SCRIPT_ID);
    assert.equal(localDirArg, tmpDir);
    assert.strictEqual(fileOpsArg, fileOps);
    assert.equal(optionsArg.prune, true);
  });

  it('returns error when push fails', async () => {
    const failingPush = makePushFn({
      success: false,
      filesPushed: [],
      error: 'API error',
    });

    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      failingPush,
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('push failed'), `got: ${result.error}`);
    assert.equal(result.scriptId, VALID_SCRIPT_ID, 'scriptId should be in error response for recovery');
    assert.ok(result.hints.recovery?.includes('pull'), `recovery hint should mention pull, got: ${result.hints.recovery}`);
  });

  // --- .clasp.json ---

  it('writes .clasp.json with correct scriptId', async () => {
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    const claspContent = await fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8');
    const clasp = JSON.parse(claspContent);
    assert.equal(clasp.scriptId, VALID_SCRIPT_ID);
  });

  // --- API failure ---

  it('API failure returns error with auth hint', async () => {
    const failingOps = {
      createProject: sinon.stub().rejects(new Error('401 Unauthorized')),
    } as unknown as GASProjectOperations;

    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      failingOps,
      makeFileOps(),
      pushFn,
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Failed to create remote project'), `got: ${result.error}`);
    assert.ok(result.hints.fix?.includes('authentication'), `got: ${result.hints.fix}`);
  });

  // --- Partial failure recovery ---

  it('partial failure (post-create error) returns scriptId for recovery', async () => {
    const throwingPush = sinon.stub().rejects(new Error('network timeout')) as PushFn & sinon.SinonStub;

    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      throwingPush,
    );

    assert.equal(result.success, false);
    assert.equal(result.scriptId, VALID_SCRIPT_ID, 'scriptId should be in error response for recovery');
    assert.ok(result.hints.recovery?.includes('pull'), `recovery hint should mention pull, got: ${result.hints.recovery}`);
  });

  // --- Directory handling ---

  it('localDir already exists — works fine', async () => {
    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );
    assert.equal(result.success, true, `expected success, got: ${result.error}`);
  });

  it('localDir does not exist — creates it', async () => {
    const newDir = path.join(tmpDir, 'new-subdir');

    const result = await handleCreateTool(
      { title: 'My Project', localDir: newDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    const stats = await fs.stat(newDir);
    assert.ok(stats.isDirectory(), 'localDir should be created');
  });

  // --- parentId ---

  it('passes parentId to createProject when provided', async () => {
    const projectOps = makeProjectOps();
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir, parentId: 'folder123' },
      projectOps,
      makeFileOps(),
      pushFn,
    );

    const createStub = projectOps.createProject as sinon.SinonStub;
    assert.equal(createStub.callCount, 1);
    assert.equal(createStub.firstCall.args[0], 'My Project');
    assert.equal(createStub.firstCall.args[1], 'folder123');
  });

  // --- Hints ---

  it('hints include deploy next step and commonjs guidance', async () => {
    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
      pushFn,
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.next?.includes('deploy'), `next hint should mention deploy, got: ${result.hints.next}`);
    assert.ok(result.hints.commonjs, 'commonjs hint should be present');
  });

  // --- Runtime verification ---

  // Safety net: restore runtime file if a test crash left it renamed
  after(async () => {
    const target = path.join(RUNTIME_DIR, RUNTIME_FILES[0].src);
    const backup = target + '.bak';
    try {
      await fs.access(backup);
      await fs.rename(backup, target);
    } catch {
      // No backup found — nothing to restore
    }
  });

  it('returns error when a runtime file is missing', async () => {
    const target = path.join(RUNTIME_DIR, RUNTIME_FILES[0].src);
    const backup = target + '.bak';
    await fs.rename(target, backup);
    try {
      const projectOps = makeProjectOps();
      const result = await handleCreateTool(
        { title: 'My Project', localDir: tmpDir },
        projectOps,
        makeFileOps(),
        pushFn,
      );
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Runtime file missing'), `got: ${result.error}`);
      assert.ok(result.hints.fix?.includes('sync-runtime'), `got: ${result.hints.fix}`);
      // createProject should NOT have been called (runtime check is pre-API)
      assert.equal((projectOps.createProject as sinon.SinonStub).callCount, 0);
    } finally {
      await fs.rename(backup, target);
    }
  });

  it('RUNTIME_DIR resolves to project root runtime/', () => {
    assert.ok(RUNTIME_DIR.endsWith('/runtime') || RUNTIME_DIR.endsWith('\\runtime'),
      `RUNTIME_DIR should end with /runtime, got: ${RUNTIME_DIR}`);
  });

  it('RUNTIME_FILES has exactly 4 entries', () => {
    assert.equal(RUNTIME_FILES.length, 4);
  });
});
