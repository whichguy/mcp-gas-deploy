/**
 * Unit tests for handleProjectsTool
 *
 * Tests: action validation, list/search result mapping, empty list,
 * Drive-scope error hint, search query forwarding, and generic API errors.
 * GASProjectOperations is mocked via sinon.
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { handleProjectsTool } from '../../src/tools/projectsTool.js';
import type { GASProjectOperations } from '../../src/api/gasProjectOperations.js';

afterEach(() => sinon.restore());

interface ProjectStub {
  scriptId: string;
  title: string;
  createTime?: string;
  updateTime?: string;
}

function makeProjectOps(projects: ProjectStub[]): GASProjectOperations {
  return {
    listProjects: sinon.stub().resolves(projects),
  } as unknown as GASProjectOperations;
}

describe('handleProjectsTool', () => {
  // --- Action validation ---

  it('returns error when search action is missing query', async () => {
    const result = await handleProjectsTool(
      { action: 'search' },
      makeProjectOps([]),
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('query is required'), `got: ${result.error}`);
  });

  // --- list action ---

  it('returns all projects with mapped fields and count hint', async () => {
    const projects: ProjectStub[] = [
      { scriptId: 'script1111111111111111', title: 'Project Alpha', createTime: '2024-01-01', updateTime: '2024-06-01' },
      { scriptId: 'script2222222222222222', title: 'Project Beta' },
      { scriptId: 'script3333333333333333', title: 'Project Gamma' },
    ];
    const result = await handleProjectsTool(
      { action: 'list' },
      makeProjectOps(projects),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 3);
    assert.ok(result.projects?.every(p => p.scriptId && p.title), 'each project should have scriptId and title');
    assert.ok(result.hints.next?.includes('Found 3'), `hint should mention Found 3, got: ${result.hints.next}`);
  });

  it('empty list returns success with count 0 and container-bound hint', async () => {
    const result = await handleProjectsTool(
      { action: 'list' },
      makeProjectOps([]),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 0);
    assert.ok(
      result.hints.next?.toLowerCase().includes('container'),
      `hint should mention container-bound scripts, got: ${result.hints.next}`,
    );
  });

  it('403 drive error triggers drive.readonly scope hint with login instruction', async () => {
    const failingOps = {
      listProjects: sinon.stub().rejects(new Error('403 Forbidden: drive scope missing')),
    } as unknown as GASProjectOperations;

    const result = await handleProjectsTool({ action: 'list' }, failingOps);

    assert.equal(result.success, false);
    assert.ok(
      result.hints.fix?.includes('drive.readonly'),
      `hint should mention drive.readonly scope, got: ${result.hints.fix}`,
    );
    assert.ok(
      result.hints.fix?.includes('login'),
      `hint should mention login, got: ${result.hints.fix}`,
    );
  });

  // --- search action ---

  it('search passes query string to listProjects', async () => {
    const projectOps = makeProjectOps([]);
    await handleProjectsTool({ action: 'search', query: 'my-project' }, projectOps);

    const listProjectsStub = projectOps.listProjects as sinon.SinonStub;
    assert.ok(listProjectsStub.calledOnce, 'listProjects should be called');
    assert.equal(listProjectsStub.firstCall.args[0], 'my-project', 'query should be forwarded');
  });

  it('search results are mapped correctly with matching count', async () => {
    const filteredProjects: ProjectStub[] = [
      { scriptId: 'match1111111111111111', title: 'Match Project 1' },
      { scriptId: 'match2222222222222222', title: 'Match Project 2' },
    ];
    const result = await handleProjectsTool(
      { action: 'search', query: 'match' },
      makeProjectOps(filteredProjects),
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.projects?.length, 2);
  });

  it('non-drive API error produces authentication hint (not drive scope)', async () => {
    const failingOps = {
      listProjects: sinon.stub().rejects(new Error('network timeout')),
    } as unknown as GASProjectOperations;

    const result = await handleProjectsTool({ action: 'list' }, failingOps);

    assert.equal(result.success, false);
    assert.ok(
      result.hints.fix?.toLowerCase().includes('authentication') ||
      result.hints.fix?.toLowerCase().includes('check'),
      `hint should mention authentication or check, got: ${result.hints.fix}`,
    );
    assert.ok(
      !result.hints.fix?.includes('drive.readonly'),
      'hint should not mention drive.readonly for non-drive errors',
    );
  });
});
