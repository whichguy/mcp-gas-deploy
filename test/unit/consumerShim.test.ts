/**
 * Unit tests for consumerShim utilities
 *
 * generateShimCode and buildConsumerManifest are pure functions — no mocking needed.
 * validateUserSymbol: assert throws on invalid identifiers, passes valid ones.
 * Consumer update non-fatal test uses sinon stubs on GASDeployOperations.
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { generateShimCode, buildConsumerManifest, validateUserSymbol } from '../../src/utils/consumerShim.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleDeployTool } from '../../src/tools/deployTool.js';
import { writeDeployConfig } from '../../src/config/deployConfig.js';
import type { GASDeployOperations } from '../../src/api/gasDeployOperations.js';
import type { GASFileOperations } from '../../src/api/gasFileOperations.js';
import type { DeploymentInfo } from '../../src/config/deployConfig.js';

const VALID_SCRIPT_ID = 'abcdefghijklmnopqrst12345678901';

// --- generateShimCode ---

describe('generateShimCode', () => {
  it('contains proxy stubs for all expected handler functions', () => {
    const code = generateShimCode('MyLib');
    const expectedFunctions = ['onOpen', 'onInstall', 'onEdit', 'exec_api', 'showSidebar', 'initialize', 'menuAction1', 'menuAction2'];
    for (const fn of expectedFunctions) {
      assert.ok(code.includes(`function ${fn}`), `missing function ${fn}`);
    }
  });

  it('includes userSymbol in every proxy stub', () => {
    const userSymbol = 'SheetsChat';
    const code = generateShimCode(userSymbol);
    const lines = code.split('\n').filter(l => l.includes('function '));
    assert.ok(lines.length > 0, 'expected at least one function line');
    for (const line of lines) {
      assert.ok(line.includes(userSymbol), `line missing userSymbol "${userSymbol}": ${line}`);
    }
  });

  it('generates different code for different userSymbols', () => {
    const code1 = generateShimCode('LibA');
    const code2 = generateShimCode('LibB');
    assert.notEqual(code1, code2);
    assert.ok(code1.includes('LibA'));
    assert.ok(code2.includes('LibB'));
  });
});

// --- buildConsumerManifest ---

describe('buildConsumerManifest', () => {
  it('sets correct libraryId from sourceScriptId', () => {
    const manifest = buildConsumerManifest('myScriptId', 'MyLib') as Record<string, unknown>;
    const libs = (manifest.dependencies as Record<string, unknown[]>).libraries;
    assert.equal(libs[0].libraryId, 'myScriptId');
  });

  it('sets version to "0" and developmentMode: true when no sourceVersionNumber given (HEAD fallback)', () => {
    const manifest = buildConsumerManifest('myScriptId', 'MyLib') as Record<string, unknown>;
    const libs = (manifest.dependencies as Record<string, unknown[]>).libraries;
    assert.equal(libs[0].version, '0');
    assert.equal(libs[0].developmentMode, true);
  });

  it('pins to specific version and sets developmentMode: false when sourceVersionNumber provided', () => {
    const manifest = buildConsumerManifest('myScriptId', 'MyLib', undefined, undefined, 5) as Record<string, unknown>;
    const libs = (manifest.dependencies as Record<string, unknown[]>).libraries;
    assert.equal(libs[0].version, '5');
    assert.equal(libs[0].developmentMode, false);
  });

  it('converts sourceVersionNumber to string in version field', () => {
    const manifest = buildConsumerManifest('myScriptId', 'MyLib', undefined, undefined, 42) as Record<string, unknown>;
    const libs = (manifest.dependencies as Record<string, unknown[]>).libraries;
    assert.equal(typeof libs[0].version, 'string');
    assert.equal(libs[0].version, '42');
  });

  it('sets userSymbol correctly', () => {
    const manifest = buildConsumerManifest('myScriptId', 'SheetsChat') as Record<string, unknown>;
    const libs = (manifest.dependencies as Record<string, unknown[]>).libraries;
    assert.equal(libs[0].userSymbol, 'SheetsChat');
  });

  it('copies oauthScopes when provided', () => {
    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
    const manifest = buildConsumerManifest('myScriptId', 'MyLib', scopes) as Record<string, unknown>;
    assert.deepEqual(manifest.oauthScopes, scopes);
  });

  it('omits oauthScopes when not provided', () => {
    const manifest = buildConsumerManifest('myScriptId', 'MyLib') as Record<string, unknown>;
    assert.ok(!('oauthScopes' in manifest), 'oauthScopes should be absent when not provided');
  });

  it('uses provided timeZone', () => {
    const manifest = buildConsumerManifest('myScriptId', 'MyLib', undefined, 'Europe/London') as Record<string, unknown>;
    assert.equal(manifest.timeZone, 'Europe/London');
  });
});

// --- validateUserSymbol ---

describe('validateUserSymbol', () => {
  it('accepts valid JS identifiers', () => {
    assert.doesNotThrow(() => validateUserSymbol('SheetsChat'));
    assert.doesNotThrow(() => validateUserSymbol('myLib'));
    assert.doesNotThrow(() => validateUserSymbol('_private'));
    assert.doesNotThrow(() => validateUserSymbol('lib123'));
  });

  it('throws on identifiers with spaces', () => {
    assert.throws(() => validateUserSymbol('My Lib'), /invalid/i);
  });

  it('throws on identifiers starting with a digit', () => {
    assert.throws(() => validateUserSymbol('1stLib'), /invalid/i);
  });

  it('throws on identifiers with special characters', () => {
    assert.throws(() => validateUserSymbol('my-lib'), /invalid/i);
    assert.throws(() => validateUserSymbol('my.lib'), /invalid/i);
    assert.throws(() => validateUserSymbol('lib@v2'), /invalid/i);
    assert.throws(() => validateUserSymbol('$helper'), /invalid/i);
  });

  it('throws on empty string', () => {
    assert.throws(() => validateUserSymbol(''), /invalid/i);
  });
});

// --- Consumer update non-fatal test ---

describe('consumer update non-fatal (via handleDeployTool)', () => {
  let tmpDir: string;

  afterEach(async () => {
    sinon.restore();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('source deploy succeeds even when consumer createVersion rejects', async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'consumer-shim-'));

    // Create appsscript.json so the pre-deploy push step doesn't fail on empty directory.
    // Using JSON avoids CommonJS validation (only SERVER_JS files are validated).
    await fs.writeFile(
      path.join(tmpDir, 'appsscript.json'),
      JSON.stringify({ timeZone: 'America/New_York', runtimeVersion: 'V8' }),
      'utf-8'
    );

    const infoWithConsumer: DeploymentInfo = {
      stagingDeploymentId: 'AKfycbStaging',
      stagingVersionNumber: 4,
      stagingUrl: 'https://script.google.com/macros/s/staging/exec',
      userSymbol: 'SheetsChat',
      stagingConsumerScriptId: 'consumerStagingScriptId',
      stagingConsumerDeploymentId: 'AKfycbConsumerStaging',
    };
    await writeDeployConfig(tmpDir, { [VALID_SCRIPT_ID]: infoWithConsumer });

    // Source deploy succeeds; consumer createVersion rejects — triggers non-fatal path
    const fileOps: GASFileOperations = {
      getProjectFiles: sinon.stub().resolves([]),
      updateProjectFiles: sinon.stub().resolves([]),  // step 4 — must not throw
    } as unknown as GASFileOperations;

    const deployOps: GASDeployOperations = {
      createVersion: sinon.stub()
        // First call: source createVersion — succeeds
        .onFirstCall().resolves({ scriptId: VALID_SCRIPT_ID, versionNumber: 5 })
        // Second call: consumer createVersion — rejects (quota exceeded)
        .onSecondCall().rejects(new Error('quota exceeded')),
      listVersions: sinon.stub().resolves([]),
      listDeployments: sinon.stub().resolves([]),
      updateDeployment: sinon.stub().resolves({
        deploymentId: 'AKfycbStaging',
        versionNumber: 5,
        updateTime: new Date().toISOString(),
        webAppUrl: 'https://script.google.com/macros/s/staging/exec',
      }),
      getOrCreateHeadDeployment: sinon.stub().resolves({ deploymentId: 'head', versionNumber: 0 }),
      createDeployment: sinon.stub().resolves({ deploymentId: 'newDeploy', versionNumber: 5, updateTime: new Date().toISOString() }),
      getDeploymentVersionNumber: sinon.stub().resolves(5),
    } as unknown as GASDeployOperations;

    const result = await handleDeployTool(
      { scriptId: VALID_SCRIPT_ID, localDir: tmpDir, action: 'deploy' },
      fileOps,
      deployOps
    );

    // Source deploy must still succeed
    assert.equal(result.success, true, `source deploy should succeed, got error: ${result.error}`);

    // Consumer error should be surfaced in consumerUpdate
    assert.ok(result.consumerUpdate, 'consumerUpdate should be present');
    assert.ok(result.consumerUpdate!.error?.includes('non-fatal'), `expected non-fatal in consumerUpdate.error, got: ${result.consumerUpdate!.error}`);

    // updateDeployment on consumer must NOT have been called (execution stops at createVersion)
    const updateDeploymentStub = deployOps.updateDeployment as sinon.SinonStub;
    // First call is for source deploy; consumer updateDeployment must not happen
    // The source updateDeployment call is args[0]=VALID_SCRIPT_ID; consumer would be consumerStagingScriptId
    const consumerUpdateCall = updateDeploymentStub.args.find(a => a[0] === 'consumerStagingScriptId');
    assert.ok(!consumerUpdateCall, 'updateDeployment should NOT be called for consumer when createVersion throws');
  });
});
