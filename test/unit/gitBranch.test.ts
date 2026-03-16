/**
 * Unit tests for gitBranch utility
 *
 * Tests branch detection, worktree detection, and detached HEAD handling.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCurrentBranch } from '../../src/utils/gitBranch.js';

const execFileAsync = promisify(execFile);
const TEST_BASE = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');

describe('getCurrentBranch', () => {
  let tmpDir: string;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'gitbranch-'));
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects branch name in a git repo', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = await getCurrentBranch(tmpDir);
    assert.equal(result.branch, 'main');
    assert.equal(result.isDetachedHead, false);
  });

  it('detects feature branch name', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    await execFileAsync('git', ['checkout', '-b', 'feat/my-feature'], { cwd: tmpDir });

    const result = await getCurrentBranch(tmpDir);
    assert.equal(result.branch, 'feat/my-feature');
    assert.equal(result.isDetachedHead, false);
  });

  it('detects detached HEAD', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    const { stdout: hash } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir });
    await execFileAsync('git', ['checkout', hash.trim()], { cwd: tmpDir });

    const result = await getCurrentBranch(tmpDir);
    assert.equal(result.isDetachedHead, true);
    assert.ok(result.branch.length > 0);
  });

  it('returns isWorktree false for main working tree', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = await getCurrentBranch(tmpDir);
    assert.equal(result.isWorktree, false);
  });
});
