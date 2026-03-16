/**
 * Git Branch Detection Utility
 *
 * Detects the current git branch for a given directory.
 * Used by fork tool for automatic branch naming and by
 * resolveProject for branch-based scriptId mapping.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BranchInfo {
  /** Current branch name (or 'HEAD' if detached) */
  branch: string;
  /** true if the directory is inside a git worktree (not the main working tree) */
  isWorktree: boolean;
  /** true if HEAD is detached (not on a named branch) */
  isDetachedHead: boolean;
}

/**
 * Get the current git branch for a directory.
 *
 * @throws Error if the directory is not a git repository or git is not available
 */
export async function getCurrentBranch(localDir: string): Promise<BranchInfo> {
  // Get symbolic ref (branch name) or fail if detached
  let branch: string;
  let isDetachedHead = false;

  try {
    const { stdout } = await execFileAsync(
      'git', ['symbolic-ref', '--short', 'HEAD'],
      { cwd: localDir, timeout: 5000 }
    );
    branch = stdout.trim();
  } catch {
    // Detached HEAD — use commit hash
    isDetachedHead = true;
    try {
      const { stdout } = await execFileAsync(
        'git', ['rev-parse', '--short', 'HEAD'],
        { cwd: localDir, timeout: 5000 }
      );
      branch = stdout.trim() || 'HEAD';
    } catch {
      branch = 'HEAD';
    }
  }

  // Check if this is a worktree
  let isWorktree = false;
  try {
    const { stdout } = await execFileAsync(
      'git', ['rev-parse', '--git-common-dir'],
      { cwd: localDir, timeout: 5000 }
    );
    const { stdout: gitDir } = await execFileAsync(
      'git', ['rev-parse', '--git-dir'],
      { cwd: localDir, timeout: 5000 }
    );
    // In a worktree, --git-dir returns a .git file path, not the common dir
    isWorktree = gitDir.trim() !== stdout.trim() && gitDir.trim() !== '.git';
  } catch {
    // Not a git repo or git not available — treat as non-worktree
  }

  return { branch, isWorktree, isDetachedHead };
}
