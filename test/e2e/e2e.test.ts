/**
 * E2E tests for mcp-gas-deploy
 *
 * Creates a real ephemeral GAS project, exercises all tool handlers against
 * the live API, then permanently deletes the project on teardown.
 *
 * Prerequisites:
 *   - Authenticated: run `mcp auth login` first
 *   - mcp_gas runtime present at ~/src/mcp_gas/gas-runtime/common-js/
 *
 * Run: npm run test:e2e
 *
 * WARNING: Tests are order-dependent — each builds on state from the previous.
 * Do NOT use --grep on individual tests; run the full suite.
 */

import { describe, it, before, after } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { SessionManager } from '../../src/auth/sessionManager.js';
import { GASAuthOperations } from '../../src/api/gasAuthOperations.js';
import { GASFileOperations } from '../../src/api/gasFileOperations.js';
import { GASDeployOperations } from '../../src/api/gasDeployOperations.js';
import { GASProjectOperations } from '../../src/api/gasProjectOperations.js';

import { handlePushTool } from '../../src/tools/pushTool.js';
import { handlePullTool } from '../../src/tools/pullTool.js';
import { handleLsTool } from '../../src/tools/lsTool.js';
import { handleStatusTool } from '../../src/tools/statusTool.js';
import { handleProjectsTool } from '../../src/tools/projectsTool.js';
import { handleDeployTool } from '../../src/tools/deployTool.js';
import { handleExecTool } from '../../src/tools/execTool.js';

// Setup chain mirrors src/server.ts wiring
const sessionManager = new SessionManager();
const authOps = new GASAuthOperations(sessionManager);
const fileOps = new GASFileOperations(authOps);
const deployOps = new GASDeployOperations(authOps);
const projectOps = new GASProjectOperations(authOps);

const REQUIRE_GS = path.join(os.homedir(), 'src/mcp_gas/gas-runtime/common-js/require.gs');
const MCP_EXEC_GS = path.join(os.homedir(), 'src/mcp_gas/gas-runtime/common-js/__mcp_exec.gs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAS_FILES_DIR = path.join(__dirname, 'gas-files');

describe('mcp-gas-deploy E2E', function () {
  this.timeout(120_000);

  let scriptId: string;
  let tmpDir: string;
  let pullDir: string | undefined;

  before(async function () {
    // Skip entire suite if not authenticated
    const token = await sessionManager.getValidToken();
    if (!token) return this.skip();

    // Skip if mcp_gas runtime is not present
    try {
      await fs.access(REQUIRE_GS);
      await fs.access(MCP_EXEC_GS);
    } catch {
      return this.skip();
    }

    // Create ephemeral GAS project
    const project = await projectOps.createProject(`mcp-e2e-test-${Date.now()}`);
    scriptId = project.scriptId;

    // Create temp directory under ~/.cache/mcp-gas-deploy-test/
    const cacheDir = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(cacheDir, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(cacheDir, 'e2e-'));

    // Copy fixture files into tmpDir
    await fs.copyFile(path.join(GAS_FILES_DIR, 'appsscript.json'), path.join(tmpDir, 'appsscript.json'));
    await fs.copyFile(path.join(GAS_FILES_DIR, 'hello.gs'), path.join(tmpDir, 'hello.gs'));
    await fs.copyFile(REQUIRE_GS, path.join(tmpDir, 'require.gs'));
    await fs.copyFile(MCP_EXEC_GS, path.join(tmpDir, '__mcp_exec.gs'));

    // Initial push — establishes remote state; must complete before tests begin
    const pushResult = await handlePushTool({ scriptId, localDir: tmpDir }, fileOps);
    if (!pushResult.success) {
      throw new Error(`E2E before(): initial push failed: ${pushResult.error}`);
    }
  });

  after(async function () {
    if (scriptId) await projectOps.trashProject(scriptId).catch(e => console.error('cleanup trashProject:', e));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(e => console.error('cleanup tmpDir:', e));
    if (pullDir) await fs.rm(pullDir, { recursive: true, force: true }).catch(e => console.error('cleanup pullDir:', e));
  });

  it('T1: ls: lists pushed files on remote', async function () {
    const result = await handleLsTool({ scriptId }, fileOps);
    assert.ok(result.success, `ls failed: ${result.error}`);
    assert.ok((result.count ?? 0) > 0, 'Expected count > 0');
    assert.ok(result.files?.some(f => f.name === 'hello'), 'Expected hello file in listing');
  });

  it('T2: status: in sync after initial push', async function () {
    const result = await handleStatusTool({ scriptId, localDir: tmpDir }, fileOps);
    assert.ok(result.success, `status failed: ${result.error}`);
    assert.ok(result.status, 'Expected status object in result');
    assert.strictEqual(result.status.modified.length, 0, 'Expected no modified files');
    assert.strictEqual(result.status.localOnly.length, 0, 'Expected no local-only files');
  });

  it('T3: pull: writes remote files to new dir, content matches', async function () {
    const cacheDir = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    pullDir = await fs.mkdtemp(path.join(cacheDir, 'e2e-pull-'));
    const result = await handlePullTool({ scriptId, targetDir: pullDir }, fileOps);
    assert.ok(result.success, `pull failed: ${result.error}`);

    // Verify hello.gs content pulled matches the original
    const original = await fs.readFile(path.join(tmpDir, 'hello.gs'), 'utf-8');
    const pulled = await fs.readFile(path.join(pullDir, 'hello.gs'), 'utf-8');
    assert.strictEqual(pulled, original, 'Expected pulled hello.gs to match original');
  });

  it('T4: status: modified file detected after local edit', async function () {
    const helloPath = path.join(tmpDir, 'hello.gs');
    const original = await fs.readFile(helloPath, 'utf-8');
    await fs.writeFile(helloPath, original + '\n// e2e-modified', 'utf-8');
    try {
      const result = await handleStatusTool({ scriptId, localDir: tmpDir }, fileOps);
      assert.ok(result.success, `status failed: ${result.error}`);
      assert.ok(result.status, 'Expected status object in result');
      assert.ok(
        result.status.modified.some(f => f.name === 'hello'),
        'Expected hello in modified list'
      );
    } finally {
      // Restore original so subsequent tests see clean state
      await fs.writeFile(helloPath, original, 'utf-8');
    }
  });

  it('T5: projects: temp project visible in listing', async function () {
    const result = await handleProjectsTool({ action: 'list' }, projectOps);
    assert.ok(result.success, `projects failed: ${result.error}`);
    assert.ok(
      result.projects?.some(p => p.scriptId === scriptId),
      'Expected temp project scriptId in projects listing'
    );
  });

  it('T6: deploy: creates staging deployment', async function () {
    const result = await handleDeployTool({ scriptId, localDir: tmpDir }, fileOps, deployOps);
    assert.ok(result.success, `deploy failed: ${result.error}`);
    assert.ok((result.versionNumber ?? 0) > 0, 'Expected versionNumber > 0');
  });

  it('T7: list-versions: shows version from deploy', async function () {
    const result = await handleDeployTool(
      { scriptId, localDir: tmpDir, action: 'list-versions' },
      fileOps,
      deployOps
    );
    assert.ok(result.success, `list-versions failed: ${result.error}`);
    assert.ok((result.versions?.length ?? 0) > 0, 'Expected at least one version');
  });

  it('T8: exec: hello.greet() returns expected string', async function () {
    // T8 uses a persistent pre-authorized fixture project so browser authorization
    // does not block automated runs. Set it up once with: npm run setup:exec-fixture
    const EXEC_FIXTURE_PATH = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test', 'exec-project.json');
    let fixture: { scriptId: string; localDir: string } | undefined;
    try {
      fixture = JSON.parse(await fs.readFile(EXEC_FIXTURE_PATH, 'utf-8'));
    } catch {
      return this.skip(); // fixture not set up — run: npm run setup:exec-fixture
    }

    const result = await handleExecTool(
      { scriptId: fixture!.scriptId, localDir: fixture!.localDir, module: 'hello', function: 'greet' },
      fileOps,
      sessionManager,
      deployOps,
    );
    // Skip if still needs browser authorization (fixture project not yet authorized)
    if (!result.success && result.error?.includes('browser authorization')) {
      return this.skip();
    }

    assert.ok(result.success, `exec failed: ${result.error}`);
    assert.ok(
      String(result.result).includes('Hello'),
      `Expected result to include 'Hello', got: ${JSON.stringify(result.result)}`,
    );
  });
});
