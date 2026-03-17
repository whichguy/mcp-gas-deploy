/**
 * Unit tests for manifestUtils utility functions.
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { parseManifest, ensureExecutionApi } from '../../src/utils/manifestUtils.js';
import type { GASFile } from '../../src/api/gasTypes.js';

function makeManifest(content: Record<string, unknown>): GASFile {
  return { name: 'appsscript', type: 'JSON', source: JSON.stringify(content) };
}

function makeFile(name: string, source?: string): GASFile {
  return { name, type: 'SERVER_JS', source };
}

describe('parseManifest', () => {
  it('returns parsed manifest object', () => {
    const files = [makeManifest({ timeZone: 'UTC', runtimeVersion: 'V8' })];
    const result = parseManifest(files);
    assert.ok(result);
    assert.equal(result.timeZone, 'UTC');
  });

  it('returns null when appsscript.json not in array', () => {
    const files = [makeFile('Code')];
    const result = parseManifest(files);
    assert.equal(result, null);
  });

  it('returns null on malformed JSON', () => {
    const files: GASFile[] = [{ name: 'appsscript', type: 'JSON', source: '{bad' }];
    const result = parseManifest(files);
    assert.equal(result, null);
  });

  it('returns null when source is empty', () => {
    const files: GASFile[] = [{ name: 'appsscript', type: 'JSON', source: undefined }];
    const result = parseManifest(files);
    assert.equal(result, null);
  });
});

describe('ensureExecutionApi', () => {
  it('adds executionApi.access when missing — updated: true', () => {
    const files = [makeManifest({ timeZone: 'UTC' })];
    const { files: result, updated } = ensureExecutionApi(files);
    assert.equal(updated, true);
    const manifest = JSON.parse(result[0].source!);
    assert.equal(manifest.executionApi.access, 'MYSELF');
  });

  it('leaves existing MYSELF value — updated: false', () => {
    const files = [makeManifest({ timeZone: 'UTC', executionApi: { access: 'MYSELF' } })];
    const original = files[0].source;
    const { files: result, updated } = ensureExecutionApi(files);
    assert.equal(updated, false);
    assert.equal(result[0].source, original);
  });

  it('upgrades non-MYSELF value — updated: true', () => {
    const files = [makeManifest({ executionApi: { access: 'ANYONE' } })];
    const { files: result, updated } = ensureExecutionApi(files);
    assert.equal(updated, true);
    const manifest = JSON.parse(result[0].source!);
    assert.equal(manifest.executionApi.access, 'MYSELF');
  });

  it('preserves existing executionApi properties when upgrading', () => {
    const files = [makeManifest({ executionApi: { access: 'ANYONE', executeAs: 'USER_DEPLOYING' } })];
    const { files: result } = ensureExecutionApi(files);
    const manifest = JSON.parse(result[0].source!);
    assert.equal(manifest.executionApi.access, 'MYSELF');
    assert.equal(manifest.executionApi.executeAs, 'USER_DEPLOYING');
  });

  it('returns unchanged when no appsscript.json in files', () => {
    const files = [makeFile('Code', 'function foo() {}')];
    const { files: result, updated } = ensureExecutionApi(files);
    assert.equal(updated, false);
    assert.deepEqual(result, files);
  });

  it('does not modify other files in the array', () => {
    const codeFile = makeFile('Code', 'function foo() {}');
    const files = [makeManifest({ timeZone: 'UTC' }), codeFile];
    const { files: result } = ensureExecutionApi(files);
    assert.equal(result[1], codeFile);
  });
});
