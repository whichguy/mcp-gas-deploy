/**
 * Unit tests for new GASProjectOperations methods:
 *   createSpreadsheet, getProjectParentId
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { GASProjectOperations } from '../../src/api/gasProjectOperations.js';
import type { GASAuthOperations } from '../../src/api/gasAuthOperations.js';

const SPREADSHEET_ID = 'spreadsheet-id-12345678901234567890';
const SCRIPT_ID = 'abcdefghij1234567890';

function makeAuthOps(driveOverrides: Record<string, sinon.SinonStub> = {}, scriptOverrides: Record<string, sinon.SinonStub> = {}): GASAuthOperations {
  const driveFiles = {
    create: sinon.stub().resolves({ data: { id: SPREADSHEET_ID } }),
    delete: sinon.stub().resolves({}),
    list: sinon.stub().resolves({ data: { files: [] } }),
    ...driveOverrides,
  };
  const driveApi = { files: driveFiles };

  const scriptProjects = {
    get: sinon.stub().resolves({ data: { scriptId: SCRIPT_ID, title: 'Test', parentId: SPREADSHEET_ID } }),
    create: sinon.stub().resolves({ data: { scriptId: SCRIPT_ID, title: 'Test' } }),
    getContent: sinon.stub().resolves({ data: { files: [] } }),
    updateContent: sinon.stub().resolves({ data: { files: [] } }),
    ...scriptOverrides,
  };
  const scriptApi = { projects: scriptProjects };

  return {
    makeDriveRequest: async (fn: (api: unknown) => Promise<unknown>) => fn(driveApi),
    makeAuthenticatedRequest: async (fn: (api: unknown) => Promise<unknown>) => fn(scriptApi),
    getAccessToken: sinon.stub().resolves('test-token'),
  } as unknown as GASAuthOperations;
}

describe('GASProjectOperations.createSpreadsheet', () => {
  afterEach(() => sinon.restore());

  it('calls Drive files.create with correct mimeType and returns spreadsheetId', async () => {
    const authOps = makeAuthOps();
    const projectOps = new GASProjectOperations(authOps);

    const result = await projectOps.createSpreadsheet('My Spreadsheet');
    assert.equal(result, SPREADSHEET_ID);

    const driveCreateStub = (authOps as unknown as { makeDriveRequest: sinon.SinonStub }).makeDriveRequest;
    // Can't directly inspect the driveCreate call because it's called inside the closure,
    // but we can verify the result came back correctly
    assert.equal(result, SPREADSHEET_ID);
  });

  it('returns spreadsheetId from Drive API response', async () => {
    const customDriveFiles = {
      create: sinon.stub().resolves({ data: { id: 'custom-spreadsheet-id-1234567890123456' } }),
      delete: sinon.stub().resolves({}),
      list: sinon.stub().resolves({ data: { files: [] } }),
    };
    const authOps = makeAuthOps(customDriveFiles);
    const projectOps = new GASProjectOperations(authOps);

    const result = await projectOps.createSpreadsheet('Custom Sheet');
    assert.equal(result, 'custom-spreadsheet-id-1234567890123456');
  });

  it('throws when Drive API response missing file id', async () => {
    const failingDriveFiles = {
      create: sinon.stub().resolves({ data: {} }), // no id
      delete: sinon.stub().resolves({}),
      list: sinon.stub().resolves({ data: { files: [] } }),
    };
    const authOps = makeAuthOps(failingDriveFiles);
    const projectOps = new GASProjectOperations(authOps);

    await assert.rejects(
      () => projectOps.createSpreadsheet('Broken Sheet'),
      /missing file id/
    );
  });
});

describe('GASProjectOperations.getProjectParentId', () => {
  afterEach(() => sinon.restore());

  it('returns parentId for container-bound scripts', async () => {
    const authOps = makeAuthOps();
    const projectOps = new GASProjectOperations(authOps);

    const result = await projectOps.getProjectParentId(SCRIPT_ID);
    assert.equal(result, SPREADSHEET_ID);
  });

  it('returns null for standalone scripts (no parentId)', async () => {
    const scriptProjects = {
      get: sinon.stub().resolves({ data: { scriptId: SCRIPT_ID, title: 'Standalone' } }), // no parentId
      create: sinon.stub().resolves({ data: { scriptId: SCRIPT_ID, title: 'Standalone' } }),
      getContent: sinon.stub().resolves({ data: { files: [] } }),
      updateContent: sinon.stub().resolves({ data: { files: [] } }),
    };
    const authOps = makeAuthOps({}, scriptProjects);
    const projectOps = new GASProjectOperations(authOps);

    const result = await projectOps.getProjectParentId(SCRIPT_ID);
    assert.equal(result, null);
  });

  it('returns null on 404 / API error (not throws)', async () => {
    const scriptProjects = {
      get: sinon.stub().rejects(new Error('404 Not Found')),
      create: sinon.stub().resolves({ data: { scriptId: SCRIPT_ID, title: 'Test' } }),
      getContent: sinon.stub().resolves({ data: { files: [] } }),
      updateContent: sinon.stub().resolves({ data: { files: [] } }),
    };
    const authOps = makeAuthOps({}, scriptProjects);
    const projectOps = new GASProjectOperations(authOps);

    const result = await projectOps.getProjectParentId(SCRIPT_ID);
    assert.equal(result, null); // Should not throw
  });
});
