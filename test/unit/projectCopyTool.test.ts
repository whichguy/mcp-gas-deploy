/**
 * Unit tests for handleProjectCopyTool
 *
 * Tests input validation, successful copy flow, error handling.
 * GASFileOperations and GASProjectOperations are mocked via sinon.
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { handleProjectCopyTool } from '../../src/tools/projectCopyTool.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { GASFile } from '../../src/api/gasTypes.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';
const NEW_SCRIPT_ID = 'newprojectid12345678';

function makeFileOps(remoteFiles: GASFile[]): GASFileOperations {
  return {
    getProjectFiles: sinon.stub().resolves(remoteFiles),
    updateProjectFiles: sinon.stub().resolves(remoteFiles),
  } as unknown as GASFileOperations;
}

function makeProjectOps(title: string | null = 'My Script'): GASProjectOperations {
  return {
    getProjectTitle: sinon.stub().resolves(title),
    createProject: sinon.stub().resolves({ scriptId: NEW_SCRIPT_ID, title: title ?? 'Copy of ' + VALID_SCRIPT_ID }),
    listProjects: sinon.stub().resolves([]),
  } as unknown as GASProjectOperations;
}

function gasFile(name: string, source = `// ${name}`, position?: number): GASFile {
  return { name, source, type: 'SERVER_JS', ...(position !== undefined ? { position } : {}) };
}

describe('handleProjectCopyTool', () => {
  afterEach(() => {
    sinon.restore();
  });

  // --- Input validation ---

  it('returns error for invalid scriptId', async () => {
    const result = await handleProjectCopyTool(
      { scriptId: 'too-short' },
      makeFileOps([]),
      makeProjectOps()
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid scriptId'), `got: ${result.error}`);
  });

  // --- Successful copy flow ---

  it('copies source files to new project', async () => {
    const files = [gasFile('main'), gasFile('utils')];
    const fileOps = makeFileOps(files);
    const projectOps = makeProjectOps('My Script');

    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
      projectOps
    );

    assert.equal(result.success, true);
    assert.equal(result.newScriptId, NEW_SCRIPT_ID);
    assert.equal(result.filesCopied, 2);
    assert.equal(result.sourceScriptId, VALID_SCRIPT_ID);

    // Verify updateProjectFiles was called with source files
    sinon.assert.calledOnce(fileOps.updateProjectFiles as sinon.SinonStub);
    const [calledScriptId, calledFiles] = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args as [string, { name: string; type: string; source: string }[]];
    assert.equal(calledScriptId, NEW_SCRIPT_ID);
    assert.equal(calledFiles.length, 2);
  });

  it('uses default title "Copy of <source title>" when no title given', async () => {
    const fileOps = makeFileOps([gasFile('main')]);
    const projectOps = makeProjectOps('Original Project');

    await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
      projectOps
    );

    const createCall = (projectOps.createProject as sinon.SinonStub).firstCall;
    assert.equal(createCall.args[0], 'Copy of Original Project');
  });

  it('uses explicit title when provided', async () => {
    const fileOps = makeFileOps([gasFile('main')]);
    const projectOps = makeProjectOps('Original');

    await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID, title: 'My Custom Copy' },
      fileOps,
      projectOps
    );

    const createCall = (projectOps.createProject as sinon.SinonStub).firstCall;
    assert.equal(createCall.args[0], 'My Custom Copy');
  });

  it('falls back to scriptId when source title cannot be fetched', async () => {
    const fileOps = makeFileOps([gasFile('main')]);
    const projectOps = makeProjectOps(null); // title not available

    await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
      projectOps
    );

    const createCall = (projectOps.createProject as sinon.SinonStub).firstCall;
    assert.ok(createCall.args[0].includes(VALID_SCRIPT_ID), `title should include scriptId, got: ${createCall.args[0]}`);
  });

  it('returns warnings about script properties and triggers', async () => {
    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps([gasFile('main')]),
      makeProjectOps('Source')
    );

    assert.ok(result.warnings && result.warnings.length > 0, 'should have warnings');
    const allWarnings = result.warnings!.join(' ');
    assert.ok(allWarnings.toLowerCase().includes('properties'), 'should warn about script properties');
    assert.ok(allWarnings.toLowerCase().includes('trigger'), 'should warn about triggers');
  });

  it('returns a next-step hint with the new scriptId', async () => {
    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps([gasFile('main')]),
      makeProjectOps()
    );

    assert.ok(result.hints.next, 'should have a next hint');
    assert.ok(result.hints.next.includes(NEW_SCRIPT_ID), `hint should include new scriptId, got: ${result.hints.next}`);
  });

  // --- Error handling ---

  it('returns error when source project has no files', async () => {
    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      makeFileOps([]), // empty
      makeProjectOps()
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('no files'), `got: ${result.error}`);
  });

  it('returns error when createProject fails', async () => {
    const fileOps = makeFileOps([gasFile('main')]);
    const projectOps = {
      getProjectTitle: sinon.stub().resolves('Title'),
      createProject: sinon.stub().rejects(new Error('Quota exceeded')),
      listProjects: sinon.stub().resolves([]),
    } as unknown as GASProjectOperations;

    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
      projectOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Quota exceeded') || result.error?.includes('copy failed'), `got: ${result.error}`);
    assert.ok(!result.hints.orphan, 'hints.orphan must not be set when createProject itself failed');
  });

  it('copy preserves source file order via orderFilesForPush', async () => {
    // Source project has files with explicit positions — copy should pass them through
    // orderFilesForPush treats all files as "known" (same positions as source), preserving order.
    const files = [
      gasFile('require', '// require', 0),
      gasFile('common-js/ConfigManager', '// cm', 1),
      gasFile('main', '// main', 2),
      { name: 'appsscript', source: '{}', type: 'JSON' as const, position: 3 },
    ];
    const fileOps = makeFileOps(files);
    const projectOps = makeProjectOps('Source');

    await handleProjectCopyTool({ scriptId: VALID_SCRIPT_ID }, fileOps, projectOps);

    const calledFiles = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as { name: string }[];
    const names = calledFiles.map(f => f.name);
    assert.equal(names[0], 'require', `require must be first, got: ${names}`);
    assert.equal(names[names.length - 1], 'appsscript', `appsscript must be last, got: ${names}`);
    assert.ok(
      names.indexOf('common-js/ConfigManager') < names.indexOf('main'),
      `ConfigManager must precede main, got: ${names}`
    );
  });

  it('returns error when updateProjectFiles fails after project creation', async () => {
    const fileOps = {
      getProjectFiles: sinon.stub().resolves([gasFile('main')]),
      updateProjectFiles: sinon.stub().rejects(new Error('Upload failed')),
    } as unknown as GASFileOperations;
    const projectOps = makeProjectOps('My Script');

    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
      projectOps
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Upload failed') || result.error?.includes('copy failed'), `got: ${result.error}`);
  });

  it('error surfaces orphaned scriptId when updateProjectFiles fails after createProject', async () => {
    const fileOps = {
      getProjectFiles: sinon.stub().resolves([gasFile('main')]),
      updateProjectFiles: sinon.stub().rejects(new Error('Upload failed')),
    } as unknown as GASFileOperations;
    const projectOps = makeProjectOps('My Script');

    const result = await handleProjectCopyTool(
      { scriptId: VALID_SCRIPT_ID },
      fileOps,
      projectOps
    );

    assert.equal(result.success, false);
    sinon.assert.calledOnce(projectOps.createProject as sinon.SinonStub);
    assert.ok(result.error?.includes(NEW_SCRIPT_ID), `error should include orphaned scriptId, got: ${result.error}`);
    assert.ok(result.hints.orphan, 'hints.orphan should be present');
    assert.ok(result.hints.orphan.includes(NEW_SCRIPT_ID), `hints.orphan should include orphaned scriptId, got: ${result.hints.orphan}`);
  });

  it('copy places loadNow files at end via orderFilesForPush', async () => {
    const loadNowSrc = `function _main() { exports.h = function() {}; }\n__defineModule__(_main, true);`;
    const regularSrc = `function _main() { exports.fn = function() {}; }\n__defineModule__(_main, false);`;
    const files: GASFile[] = [
      { name: 'events', source: loadNowSrc, type: 'SERVER_JS', position: 0 },
      { name: 'utils', source: regularSrc, type: 'SERVER_JS', position: 1 },
    ];
    const fileOps = makeFileOps(files);
    await handleProjectCopyTool({ scriptId: VALID_SCRIPT_ID }, fileOps, makeProjectOps());
    const called = (fileOps.updateProjectFiles as sinon.SinonStub).firstCall.args[1] as { name: string }[];
    assert.equal(called[0].name, 'utils', 'non-loadNow file must be first');
    assert.equal(called[called.length - 1].name, 'events', 'loadNow file must be last in copy payload');
  });
});
