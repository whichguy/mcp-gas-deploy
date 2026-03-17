/**
 * Unit tests for filePrepare utility functions.
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { stripMcpEnvironments, enforceDeployFileOrder, prepareFilesForDeploy } from '../../src/utils/filePrepare.js';
import type { GASFile } from '../../src/api/gasTypes.js';

function makeFile(name: string, source?: string, type: GASFile['type'] = 'SERVER_JS'): GASFile {
  return { name, type, source };
}

function makeManifest(content: Record<string, unknown>): GASFile {
  return { name: 'appsscript', type: 'JSON', source: JSON.stringify(content) };
}

const CRITICAL_FILES: GASFile[] = [
  makeFile('common-js/require'),
  makeFile('common-js/ConfigManager'),
  makeFile('common-js/__mcp_exec'),
];

describe('stripMcpEnvironments', () => {
  it('removes mcp_environments from manifest', () => {
    const files = [
      makeManifest({ timeZone: 'America/New_York', mcp_environments: { staging: 'abc' }, runtimeVersion: 'V8' }),
      makeFile('Code'),
    ];
    const result = stripMcpEnvironments(files);
    const manifest = JSON.parse(result[0].source!);
    assert.ok(!('mcp_environments' in manifest));
    assert.equal(manifest.timeZone, 'America/New_York');
    assert.equal(manifest.runtimeVersion, 'V8');
  });

  it('leaves manifest unchanged when no mcp_environments', () => {
    const files = [
      makeManifest({ timeZone: 'America/New_York', runtimeVersion: 'V8' }),
    ];
    const result = stripMcpEnvironments(files);
    assert.equal(result[0].source, files[0].source);
  });

  it('leaves non-manifest files unchanged', () => {
    const codeFile = makeFile('Code', 'function foo() {}');
    const files = [codeFile];
    const result = stripMcpEnvironments(files);
    assert.equal(result[0], codeFile);
  });

  it('handles malformed JSON gracefully', () => {
    const badManifest: GASFile = { name: 'appsscript', type: 'JSON', source: '{bad json' };
    const result = stripMcpEnvironments([badManifest]);
    assert.equal(result[0], badManifest);
  });
});

describe('enforceDeployFileOrder', () => {
  it('places critical files at positions 0, 1, 2', () => {
    const files = [
      makeFile('myApp'),
      makeFile('common-js/__mcp_exec'),
      makeFile('common-js/ConfigManager'),
      makeFile('common-js/require'),
      makeFile('common-js/utils'),
    ];
    const result = enforceDeployFileOrder(files);
    assert.equal(result[0].name, 'common-js/require');
    assert.equal(result[1].name, 'common-js/ConfigManager');
    assert.equal(result[2].name, 'common-js/__mcp_exec');
  });

  it('preserves non-critical files after critical files', () => {
    const files = [
      ...CRITICAL_FILES,
      makeFile('common-js/utils'),
      makeFile('myApp'),
    ];
    const result = enforceDeployFileOrder(files);
    assert.equal(result.length, 5);
    // Non-critical common-js before non-common-js
    assert.equal(result[3].name, 'common-js/utils');
    assert.equal(result[4].name, 'myApp');
  });

  it('throws on missing critical file', () => {
    const files = [
      makeFile('common-js/require'),
      makeFile('common-js/ConfigManager'),
      // missing __mcp_exec
      makeFile('myApp'),
    ];
    assert.throws(
      () => enforceDeployFileOrder(files),
      /Required file "common-js\/__mcp_exec" is missing/
    );
  });

  it('does not lose any common-js files', () => {
    const files = [
      ...CRITICAL_FILES,
      makeFile('common-js/utils'),
      makeFile('common-js/helpers'),
    ];
    const result = enforceDeployFileOrder(files);
    const commonJsFiles = result.filter(f => f.name.startsWith('common-js/'));
    assert.equal(commonJsFiles.length, 5);
  });
});

describe('prepareFilesForDeploy', () => {
  it('strips mcp_environments AND enforces order', () => {
    const files = [
      makeManifest({ timeZone: 'UTC', mcp_environments: { staging: 'x' } }),
      makeFile('myApp'),
      makeFile('common-js/__mcp_exec'),
      makeFile('common-js/ConfigManager'),
      makeFile('common-js/require'),
    ];
    const result = prepareFilesForDeploy(files);
    // Order enforced
    assert.equal(result[0].name, 'common-js/require');
    assert.equal(result[1].name, 'common-js/ConfigManager');
    assert.equal(result[2].name, 'common-js/__mcp_exec');
    // mcp_environments stripped
    const manifest = result.find(f => f.name === 'appsscript');
    assert.ok(manifest);
    assert.ok(!JSON.parse(manifest.source!).mcp_environments);
  });
});
