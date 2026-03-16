/**
 * Unit tests for handleForkTool
 *
 * Tests: resolve failure, successful fork, push failure, idempotent check,
 * GCP switch failure (fallback), branch detection, clasp.json mapping.
 */

import { describe, it, beforeEach, afterEach, after } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleForkTool } from '../../src/tools/forkTool.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { ChromeDevtools } from '../../src/utils/gcpSwitch.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';
const FORK_SCRIPT_ID = 'forkscriptid1234567890';

const TEST_BASE = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');

function makeProjectOps(forkId: string = FORK_SCRIPT_ID): GASProjectOperations {
  return {
    createProject: sinon.stub().resolves({ scriptId: forkId, title: 'Fork: test' }),
    listProjects: sinon.stub().resolves([]),
    getProjectTitle: sinon.stub().resolves('Fork: test'),
    trashProject: sinon.stub().resolves(),
  } as unknown as GASProjectOperations;
}

function makeFileOps(): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves([]),
    updateProjectFiles: sinon.stub().resolves([]),
  } as unknown as GASFileOperations;
}

function makeDevtools(success: boolean = true): ChromeDevtools {
  let callCount = 0;
  return {
    navigate_page: async () => ({}),
    evaluate_script: async () => {
      callCount++;
      if (callCount === 1) {
        return { result: JSON.stringify({ xsrf: 'test', session: '', buildLabel: '' }) };
      }
      return { result: JSON.stringify({ success }) };
    },
  };
}

describe('handleForkTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'fork-'));
    // Create a minimal project setup
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'appsscript.json'),
      JSON.stringify({ timeZone: 'America/New_York', runtimeVersion: 'V8' }),
      'utf-8'
    );
  });

  afterEach(async () => {
    sinon.restore();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  after(async () => {
    try { await fs.rm(TEST_BASE, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it('fails when neither scriptId nor localDir provided', async () => {
    const result = await handleForkTool({}, makeProjectOps(), makeFileOps());
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('required'));
  });

  it('creates fork and returns forkScriptId', async () => {
    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'feat/test' },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.success, true);
    assert.equal(result.forkScriptId, FORK_SCRIPT_ID);
    assert.equal(result.sourceScriptId, VALID_SCRIPT_ID);
    assert.equal(result.branch, 'feat/test');
  });

  it('uses web-app-fallback when no chromeDevtools', async () => {
    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'test' },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.success, true);
    assert.equal(result.execMode, 'web-app-fallback');
  });

  it('uses scripts-run when GCP switch succeeds', async () => {
    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'test', gcpProjectNumber: '428972970708' },
      makeProjectOps(),
      makeFileOps(),
      makeDevtools(true),
    );

    assert.equal(result.success, true);
    assert.equal(result.execMode, 'scripts-run');
  });

  it('falls back to web-app-fallback when GCP switch fails', async () => {
    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'test', gcpProjectNumber: '428972970708' },
      makeProjectOps(),
      makeFileOps(),
      makeDevtools(false),
    );

    assert.equal(result.success, true);
    assert.equal(result.execMode, 'web-app-fallback');
  });

  it('returns existing fork if branch already mapped in .clasp.json', async () => {
    // Write a .clasp.json with existing branch mapping
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({
        scriptId: VALID_SCRIPT_ID,
        branches: { 'feat/existing': 'existingForkScriptId12345' },
      }),
      'utf-8'
    );

    const projectOps = makeProjectOps();
    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'feat/existing' },
      projectOps,
      makeFileOps(),
    );

    assert.equal(result.success, true);
    assert.equal(result.forkScriptId, 'existingForkScriptId12345');
    // createProject should NOT have been called
    assert.equal((projectOps.createProject as sinon.SinonStub).called, false);
    assert.ok(result.hints.existing?.includes('already exists'));
  });

  it('writes branch mapping to .clasp.json on success', async () => {
    await handleForkTool(
      { localDir: tmpDir, branch: 'feat/new-fork' },
      makeProjectOps(),
      makeFileOps(),
    );

    const clasp = JSON.parse(await fs.readFile(path.join(tmpDir, '.clasp.json'), 'utf-8'));
    assert.equal(clasp.branches['feat/new-fork'], FORK_SCRIPT_ID);
    // Original scriptId preserved
    assert.equal(clasp.scriptId, VALID_SCRIPT_ID);
  });

  it('returns error when createProject fails', async () => {
    const ops = makeProjectOps();
    (ops.createProject as sinon.SinonStub).rejects(new Error('quota exceeded'));

    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'test' },
      ops,
      makeFileOps(),
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('quota exceeded'));
  });

  it('returns partial failure when push fails', async () => {
    const fileOps = makeFileOps();
    // Push calls updateProjectFiles which throws
    (fileOps.updateProjectFiles as sinon.SinonStub).rejects(new Error('network error'));

    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'test' },
      makeProjectOps(),
      fileOps,
    );

    assert.equal(result.success, false);
    assert.ok(result.forkScriptId, 'should include forkScriptId for recovery');
    assert.ok(result.error?.includes('push failed'));
    assert.ok(result.hints.recovery?.includes(FORK_SCRIPT_ID));
  });

  it('uses custom title when provided', async () => {
    const ops = makeProjectOps();
    await handleForkTool(
      { localDir: tmpDir, branch: 'test', title: 'My Custom Fork' },
      ops,
      makeFileOps(),
    );

    const createCall = (ops.createProject as sinon.SinonStub).firstCall;
    assert.equal(createCall.args[0], 'My Custom Fork');
  });

  it('defaults fork title to "Fork: <branch>"', async () => {
    const ops = makeProjectOps();
    await handleForkTool(
      { localDir: tmpDir, branch: 'feat/awesome' },
      ops,
      makeFileOps(),
    );

    const createCall = (ops.createProject as sinon.SinonStub).firstCall;
    assert.equal(createCall.args[0], 'Fork: feat/awesome');
  });

  it('auto-detects branch when not provided', async () => {
    // tmpDir is inside a git repo (the project repo) — branch detection succeeds
    const result = await handleForkTool(
      { localDir: tmpDir },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.success, true);
    // Branch should be detected (whatever the current branch is)
    assert.ok(typeof result.branch === 'string');
    assert.ok(result.branch!.length > 0);
  });

  it('shows gcpProjectNumber hint when no GCP number provided', async () => {
    const result = await handleForkTool(
      { localDir: tmpDir, branch: 'test' },
      makeProjectOps(),
      makeFileOps(),
    );

    assert.equal(result.execMode, 'web-app-fallback');
    assert.ok(result.hints.gcpProjectNumber?.includes('console.cloud.google.com'));
  });
});
