/**
 * Unit tests for handleCreateTool
 *
 * Tests: missing title, successful create, API failure, partial failure recovery,
 * localDir already exists, localDir doesn't exist (creates it), path traversal guard.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleCreateTool } from '../../src/tools/createTool.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';

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

describe('handleCreateTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'create-'));
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
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('title is required'), `got: ${result.error}`);
  });

  it('returns error when title is whitespace only', async () => {
    const result = await handleCreateTool(
      { title: '   ' },
      makeProjectOps(),
      makeFileOps(),
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
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('home directory'), `got: ${result.error}`);
  });

  // --- Successful create ---

  it('successful create returns scriptId, title, localDir, and files', async () => {
    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);
    assert.equal(result.scriptId, VALID_SCRIPT_ID);
    assert.equal(result.title, 'Test Project');
    assert.equal(result.localDir, tmpDir);

    // appsscript.json should be written
    const manifestContent = await fs.readFile(path.join(tmpDir, 'appsscript.json'), 'utf-8');
    const manifest = JSON.parse(manifestContent);
    assert.equal(manifest.runtimeVersion, 'V8');
    assert.equal(manifest.timeZone, 'America/New_York');

    // .clasp.json should be written
    const claspContent = await fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8');
    const clasp = JSON.parse(claspContent);
    assert.equal(clasp.scriptId, VALID_SCRIPT_ID);
  });

  it('pushes appsscript.json to remote', async () => {
    const fileOps = makeFileOps();
    await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      fileOps,
    );

    const updateStub = fileOps.updateProjectFiles as sinon.SinonStub;
    assert.equal(updateStub.callCount, 1, 'updateProjectFiles should be called once');
    const [scriptIdArg, filesArg] = updateStub.firstCall.args;
    assert.equal(scriptIdArg, VALID_SCRIPT_ID);
    assert.equal(filesArg.length, 1);
    assert.equal(filesArg[0].name, 'appsscript');
    assert.equal(filesArg[0].type, 'JSON');
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
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Failed to create remote project'), `got: ${result.error}`);
    assert.ok(result.hints.fix?.includes('authentication'), `got: ${result.hints.fix}`);
  });

  // --- Partial failure recovery ---

  it('partial failure (push fails) returns scriptId for recovery', async () => {
    const failingFileOps = {
      getProjectFiles: sinon.stub().resolves([]),
      updateProjectFiles: sinon.stub().rejects(new Error('push failed')),
    } as unknown as GASFileOperations;

    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      failingFileOps,
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
    );
    assert.equal(result.success, true, `expected success, got: ${result.error}`);
  });

  it('localDir does not exist — creates it', async () => {
    const newDir = path.join(tmpDir, 'new-subdir');

    const result = await handleCreateTool(
      { title: 'My Project', localDir: newDir },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.success, true, `expected success, got: ${result.error}`);

    // Directory should have been created
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
    );

    const createStub = projectOps.createProject as sinon.SinonStub;
    assert.equal(createStub.callCount, 1);
    assert.equal(createStub.firstCall.args[0], 'My Project');
    assert.equal(createStub.firstCall.args[1], 'folder123');
  });

  // --- Hints ---

  it('hints include next step and commonjs guidance', async () => {
    const result = await handleCreateTool(
      { title: 'My Project', localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.success, true);
    assert.ok(result.hints.next?.includes('push'), `next hint should mention push, got: ${result.hints.next}`);
    assert.ok(result.hints.commonjs, 'commonjs hint should be present');
  });
});
