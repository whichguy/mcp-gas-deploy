/**
 * Unit tests for resolveProject utility
 *
 * Tests: resolution cascade (4 paths), isOverride logic, path traversal guard,
 * .clasp.json reading, scriptId validation, reparent behavior, ~ expansion.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveProject, readClaspJson } from '../../src/utils/resolveProject.js';

const VALID_SCRIPT_ID = 'abcdefghij1234567890';
const ALT_SCRIPT_ID = 'zyxwvutsrq0987654321';

describe('resolveProject', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'resolve-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Case 1: localDir with .clasp.json (no explicit scriptId) ---

  it('reads scriptId from .clasp.json when scriptId is omitted', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );

    const result = await resolveProject({ localDir: tmpDir });
    assert.equal(result.scriptId, VALID_SCRIPT_ID);
    assert.equal(result.localDir, tmpDir);
    assert.equal(result.isOverride, false);
  });

  // --- Case 2: localDir without .clasp.json + explicit scriptId ---

  it('uses explicit scriptId when .clasp.json is absent', async () => {
    const result = await resolveProject({ scriptId: VALID_SCRIPT_ID, localDir: tmpDir });
    assert.equal(result.scriptId, VALID_SCRIPT_ID);
    assert.equal(result.localDir, tmpDir);
    assert.equal(result.isOverride, false);
  });

  // --- Case 3: scriptId only (no localDir) → fallback ~/gas-projects/<scriptId> ---

  it('falls back to ~/gas-projects/<scriptId> when localDir is omitted', async () => {
    const result = await resolveProject({ scriptId: VALID_SCRIPT_ID });
    assert.equal(result.scriptId, VALID_SCRIPT_ID);
    assert.ok(result.localDir.includes('gas-projects'));
    assert.ok(result.localDir.includes(VALID_SCRIPT_ID));
    assert.equal(result.isOverride, false);
  });

  // --- Case 4: Neither provided → error ---

  it('throws when neither scriptId nor localDir is provided', async () => {
    await assert.rejects(
      () => resolveProject({}),
      (err: Error) => {
        assert.ok(err.message.includes('Either scriptId or localDir'));
        return true;
      }
    );
  });

  // --- isOverride: explicit scriptId differs from .clasp.json ---

  it('sets isOverride=true when explicit scriptId differs from .clasp.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );

    const result = await resolveProject({ scriptId: ALT_SCRIPT_ID, localDir: tmpDir });
    assert.equal(result.scriptId, ALT_SCRIPT_ID);
    assert.equal(result.isOverride, true);
    assert.ok(result.warnings?.[0]?.includes('differs from .clasp.json'));
  });

  it('sets isOverride=false when explicit scriptId matches .clasp.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );

    const result = await resolveProject({ scriptId: VALID_SCRIPT_ID, localDir: tmpDir });
    assert.equal(result.isOverride, false);
    assert.equal(result.warnings, undefined);
  });

  // --- Path traversal guard ---

  it('throws when localDir resolves outside home directory', async () => {
    await assert.rejects(
      () => resolveProject({ scriptId: VALID_SCRIPT_ID, localDir: '/etc/config' }),
      (err: Error) => {
        assert.ok(err.message.includes('home directory'));
        return true;
      }
    );
  });

  // --- scriptId validation ---

  it('throws for invalid explicit scriptId format', async () => {
    await assert.rejects(
      () => resolveProject({ scriptId: 'bad', localDir: tmpDir }),
      (err: Error) => {
        assert.ok(err.message.includes('Invalid scriptId format'));
        return true;
      }
    );
  });

  // --- Malformed .clasp.json ---

  it('throws when .clasp.json has empty scriptId and no explicit scriptId', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: '' }),
      'utf-8'
    );

    await assert.rejects(
      () => resolveProject({ localDir: tmpDir }),
      (err: Error) => {
        assert.ok(err.message.includes('No scriptId provided'));
        return true;
      }
    );
  });

  it('throws when .clasp.json has invalid scriptId and no explicit scriptId', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: 'short' }),
      'utf-8'
    );

    await assert.rejects(
      () => resolveProject({ localDir: tmpDir }),
      (err: Error) => {
        assert.ok(err.message.includes('No scriptId provided'));
        return true;
      }
    );
  });

  it('throws when .clasp.json is malformed JSON and no explicit scriptId', async () => {
    await fs.writeFile(path.join(tmpDir, '.clasp.json'), '{broken', 'utf-8');

    await assert.rejects(
      () => resolveProject({ localDir: tmpDir }),
      (err: Error) => {
        assert.ok(err.message.includes('No scriptId provided'));
        return true;
      }
    );
  });

  // --- ~ expansion ---

  it('expands ~ prefix in localDir', async () => {
    // Use a path that starts with ~ — should resolve to home
    const result = await resolveProject({ scriptId: VALID_SCRIPT_ID, localDir: '~/test-dir' });
    assert.ok(result.localDir.startsWith(os.homedir()));
    assert.ok(result.localDir.endsWith('test-dir'));
  });

  // --- resolvedFrom ---

  it('resolvedFrom is "clasp-json" when scriptId comes from .clasp.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );
    const result = await resolveProject({ localDir: tmpDir });
    assert.equal(result.resolvedFrom, 'clasp-json');
  });

  it('resolvedFrom is "explicit" when scriptId provided with localDir', async () => {
    const result = await resolveProject({ scriptId: VALID_SCRIPT_ID, localDir: tmpDir });
    assert.equal(result.resolvedFrom, 'explicit');
  });

  it('resolvedFrom is "default" when only scriptId provided (no localDir)', async () => {
    const result = await resolveProject({ scriptId: VALID_SCRIPT_ID });
    assert.equal(result.resolvedFrom, 'default');
  });

  it('resolvedFrom is "explicit" when explicit scriptId overrides .clasp.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );
    const result = await resolveProject({ scriptId: ALT_SCRIPT_ID, localDir: tmpDir });
    assert.equal(result.resolvedFrom, 'explicit');
    assert.equal(result.isOverride, true);
  });
});

describe('readClaspJson', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');
    await fs.mkdir(base, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(base, 'clasp-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns scriptId from valid .clasp.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: VALID_SCRIPT_ID }),
      'utf-8'
    );
    const result = await readClaspJson(tmpDir);
    assert.deepEqual(result, { scriptId: VALID_SCRIPT_ID });
  });

  it('returns null when .clasp.json does not exist', async () => {
    const result = await readClaspJson(tmpDir);
    assert.equal(result, null);
  });

  it('returns null when scriptId is empty', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: '' }),
      'utf-8'
    );
    const result = await readClaspJson(tmpDir);
    assert.equal(result, null);
  });

  it('returns null when scriptId is missing', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ otherField: 'value' }),
      'utf-8'
    );
    const result = await readClaspJson(tmpDir);
    assert.equal(result, null);
  });

  it('returns null for invalid scriptId format', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.clasp.json'),
      JSON.stringify({ scriptId: 'too-short' }),
      'utf-8'
    );
    const result = await readClaspJson(tmpDir);
    assert.equal(result, null);
  });

  it('returns null for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, '.clasp.json'), '{bad json', 'utf-8');
    const result = await readClaspJson(tmpDir);
    assert.equal(result, null);
  });
});
