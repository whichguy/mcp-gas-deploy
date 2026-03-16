/**
 * Unit tests for .claspignore parsing
 *
 * Tests the loadClaspIgnore() function: file presence, pattern matching,
 * comments, negation, directory globs, and globstar patterns.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadClaspIgnore } from '../../src/sync/claspIgnore.js';

describe('loadClaspIgnore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claspignore-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns inactive no-op filter when .claspignore does not exist', async () => {
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.active, false);
    assert.equal(result.patternCount, 0);
    assert.equal(result.accepts('anything.gs'), true);
    assert.equal(result.accepts('deep/nested/file.html'), true);
  });

  it('returns active filter with patternCount=0 for empty file', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), '', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.active, true);
    assert.equal(result.patternCount, 0);
    assert.equal(result.accepts('anything.gs'), true);
  });

  it('ignores comments and blank lines in pattern count', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), '# comment\n\n*.test.gs\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.active, true);
    assert.equal(result.patternCount, 1);
  });

  it('excludes files matching simple glob *.test.gs', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), '*.test.gs\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.accepts('foo.test.gs'), false);
    assert.equal(result.accepts('foo.gs'), true);
  });

  it('excludes files in directory pattern test/**', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), 'test/**\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.accepts('test/foo.gs'), false);
    assert.equal(result.accepts('test/sub/bar.gs'), false);
    assert.equal(result.accepts('src/foo.gs'), true);
  });

  it('excludes deeply nested files with globstar **/test/**', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), '**/test/**\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.accepts('a/b/test/foo.gs'), false);
    assert.equal(result.accepts('test/foo.gs'), false);
    assert.equal(result.accepts('src/foo.gs'), true);
  });

  it('supports negation to re-include excluded files', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.claspignore'),
      '*.test.gs\n!critical.test.gs\n',
      'utf-8'
    );
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.patternCount, 2);
    assert.equal(result.accepts('foo.test.gs'), false);
    assert.equal(result.accepts('critical.test.gs'), true);
  });

  it('excludes a specific file by name', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), 'scratch.gs\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.accepts('scratch.gs'), false);
    assert.equal(result.accepts('main.gs'), true);
  });

  it('excludes a file in a subdirectory', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), 'common-js/debug.gs\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.accepts('common-js/debug.gs'), false);
    assert.equal(result.accepts('common-js/utils.gs'), true);
  });

  it('handles multiple patterns correctly', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.claspignore'),
      '*.test.gs\nscratch.gs\ntest/**\n',
      'utf-8'
    );
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.patternCount, 3);
    assert.equal(result.accepts('foo.test.gs'), false);
    assert.equal(result.accepts('scratch.gs'), false);
    assert.equal(result.accepts('test/suite.gs'), false);
    assert.equal(result.accepts('main.gs'), true);
  });

  it('excludes directory by name (trailing slash)', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), 'build/\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.accepts('build/output.gs'), false);
    assert.equal(result.accepts('builder.gs'), true);
  });

  it('handles Windows-style CRLF in .claspignore', async () => {
    await fs.writeFile(path.join(tmpDir, '.claspignore'), '*.test.gs\r\nscratch.gs\r\n', 'utf-8');
    const result = await loadClaspIgnore(tmpDir);
    assert.equal(result.patternCount, 2);
    assert.equal(result.accepts('foo.test.gs'), false);
    assert.equal(result.accepts('scratch.gs'), false);
    assert.equal(result.accepts('main.gs'), true);
  });
});
