/**
 * One-time setup: creates a persistent GAS project for exec E2E testing.
 *
 * Creates a long-lived project, pushes test files, deploys, and obtains
 * the HEAD deployment URL. The project must be browser-authorized once
 * by visiting the printed URL in Chrome after this script completes.
 *
 * Usage:
 *   npm run setup:exec-fixture
 *
 * Output:
 *   ~/.cache/mcp-gas-deploy-test/exec-project.json
 *   { scriptId, headUrl, localDir }
 *
 * Re-run to refresh files/deployment on the existing fixture project.
 * Delete exec-project.json to force creation of a new project.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { SessionManager } from '../../src/auth/sessionManager.js';
import { GASAuthOperations } from '../../src/api/gasAuthOperations.js';
import { GASFileOperations } from '../../src/api/gasFileOperations.js';
import { GASDeployOperations } from '../../src/api/gasDeployOperations.js';
import { GASProjectOperations } from '../../src/api/gasProjectOperations.js';

import { handlePushTool } from '../../src/tools/pushTool.js';
import { handleDeployTool } from '../../src/tools/deployTool.js';
import { setDeploymentInfo } from '../../src/config/deployConfig.js';

const REQUIRE_GS = path.join(os.homedir(), 'src/mcp_gas/gas-runtime/common-js/require.gs');
const MCP_EXEC_GS = path.join(os.homedir(), 'src/mcp_gas/gas-runtime/common-js/__mcp_exec.gs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAS_FILES_DIR = path.join(__dirname, 'gas-files');
const EXEC_FIXTURE_PATH = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test', 'exec-project.json');
const FIXTURE_LOCAL_DIR = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test', 'exec-fixture');

async function main() {
  const sessionManager = new SessionManager();
  const token = await sessionManager.getValidToken();
  if (!token) {
    console.error('ERROR: Not authenticated — run mcp auth login first');
    process.exit(1);
  }

  const authOps = new GASAuthOperations(sessionManager);
  const fileOps = new GASFileOperations(authOps);
  const deployOps = new GASDeployOperations(authOps);
  const projectOps = new GASProjectOperations(authOps);

  // Reuse existing fixture project if config exists
  let scriptId: string | undefined;
  try {
    const existing = JSON.parse(await fs.readFile(EXEC_FIXTURE_PATH, 'utf-8'));
    scriptId = existing.scriptId;
    console.log(`Reusing existing exec fixture project: ${scriptId}`);
  } catch {
    // Create a new project
    const project = await projectOps.createProject('mcp-e2e-exec-fixture');
    scriptId = project.scriptId;
    console.log(`Created exec fixture project: ${scriptId}`);
  }

  // Prepare persistent local dir with test files
  await fs.mkdir(FIXTURE_LOCAL_DIR, { recursive: true });
  await fs.copyFile(path.join(GAS_FILES_DIR, 'appsscript.json'), path.join(FIXTURE_LOCAL_DIR, 'appsscript.json'));
  await fs.copyFile(path.join(GAS_FILES_DIR, 'hello.gs'), path.join(FIXTURE_LOCAL_DIR, 'hello.gs'));
  await fs.copyFile(REQUIRE_GS, path.join(FIXTURE_LOCAL_DIR, 'require.gs'));
  await fs.copyFile(MCP_EXEC_GS, path.join(FIXTURE_LOCAL_DIR, '__mcp_exec.gs'));
  console.log('Copied test files to', FIXTURE_LOCAL_DIR);

  // Push files to GAS
  const pushResult = await handlePushTool({ scriptId: scriptId!, localDir: FIXTURE_LOCAL_DIR }, fileOps);
  if (!pushResult.success) {
    console.error('ERROR: Push failed:', pushResult.error);
    if (pushResult.validationErrors) console.error(pushResult.validationErrors);
    process.exit(1);
  }
  console.log(`Pushed ${pushResult.filesPushed?.length ?? 0} files`);

  // Deploy (creates staging deployment + discovers available deployments)
  const deployResult = await handleDeployTool(
    { scriptId: scriptId!, localDir: FIXTURE_LOCAL_DIR },
    fileOps,
    deployOps,
  );
  if (!deployResult.success) {
    console.error('ERROR: Deploy failed:', deployResult.error);
    process.exit(1);
  }
  console.log(`Deployed v${deployResult.versionNumber}`);

  // Obtain HEAD deployment URL (creates if absent, always idempotent)
  const headDeployment = await deployOps.getOrCreateHeadDeployment(scriptId!);
  if (!headDeployment.webAppUrl) {
    console.error('ERROR: HEAD deployment has no web app URL — ensure appsscript.json has webapp config');
    process.exit(1);
  }
  const headUrl = headDeployment.webAppUrl;

  // Cache headUrl in the fixture's gas-deploy.json so exec skips getOrCreateHeadDeployment
  await setDeploymentInfo(FIXTURE_LOCAL_DIR, scriptId!, {
    headUrl,
    headDeploymentId: headDeployment.deploymentId,
  });

  // Write exec-project.json
  const fixture = { scriptId: scriptId!, headUrl, localDir: FIXTURE_LOCAL_DIR };
  await fs.mkdir(path.dirname(EXEC_FIXTURE_PATH), { recursive: true });
  await fs.writeFile(EXEC_FIXTURE_PATH, JSON.stringify(fixture, null, 2), 'utf-8');

  console.log('\n✓ Exec fixture ready');
  console.log(`  scriptId: ${scriptId}`);
  console.log(`  headUrl:  ${headUrl}`);
  console.log(`  localDir: ${FIXTURE_LOCAL_DIR}`);
  console.log('\n*** BROWSER AUTHORIZATION REQUIRED (one-time per project) ***');
  console.log('Visit this URL in Chrome signed in as the Google account that owns the script:');
  console.log(`\n  ${headUrl}\n`);
  console.log('Click "Allow" when prompted to authorize the web app.');
  console.log('Then run: npm run test:e2e');
}

main().catch(e => {
  console.error('setup-exec-fixture failed:', e);
  process.exit(1);
});
