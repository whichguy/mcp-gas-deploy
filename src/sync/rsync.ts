/**
 * Sync Engine for mcp_gas_deploy
 *
 * Handles pull (GAS → local), push (local → GAS with validation), and
 * status diffing between local and remote files via Git SHA-1 hashes.
 *
 * Navigation comments mark the key decision points:
 * - HASH_MISMATCH: where local vs remote divergence is detected
 * - SYNC_STATE: where pull direction is tracked via .gas-sync-state.json
 * - AUTO_PUSH: where push is triggered before exec
 * - LOCK_GUARD: where concurrent push protection applies
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gitBlobSha1 } from './hashUtils.js';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { validateFilesErrors, type ValidationResult } from '../validation/commonjsValidator.js';
import type { GASFile } from '../api/gasTypes.js';

// --- Constants ---

/** Operational state file — tracks remote hashes at last pull for directional status. */
const SYNC_STATE_FILE = '.gas-sync-state.json';

// --- Types ---

export interface SyncStatus {
  inSync: FileStatus[];
  localAhead: FileStatus[];
  remoteAhead: FileStatus[];
  localOnly: FileStatus[];
  remoteOnly: FileStatus[];
}

export interface FileStatus {
  name: string;
  localHash?: string;
  remoteHash?: string;
}

export interface PushResult {
  success: boolean;
  filesPushed: string[];
  validationErrors?: ValidationResult[];
  error?: string;
}

export interface PullResult {
  success: boolean;
  filesPulled: string[];
  error?: string;
}

// --- File-level push lock (prevents concurrent push race) ---

const pushLocks = new Map<string, Promise<void>>();

async function withPushLock<T>(scriptId: string, fn: () => Promise<T>): Promise<T> {
  // Wait for existing lock on this scriptId
  while (pushLocks.has(scriptId)) {
    await pushLocks.get(scriptId);
  }

  let resolve: () => void;
  const lockPromise = new Promise<void>(r => { resolve = r; });
  pushLocks.set(scriptId, lockPromise);

  try {
    return await fn();
  } finally {
    pushLocks.delete(scriptId);
    resolve!();
  }
}

// --- Sync state helpers ---

/**
 * SYNC_STATE: Read remote hashes recorded at last pull.
 * Returns null if state file is absent (first pull not done) or corrupt.
 */
async function readSyncState(localDir: string): Promise<Map<string, string> | null> {
  const statePath = path.join(localDir, SYNC_STATE_FILE);
  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, string>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`[rsync] Corrupt sync state at ${statePath} — ignoring`);
      return null;
    }
    return new Map(Object.entries(parsed));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`[rsync] Error reading sync state: ${(error as Error).message}`);
    return null;
  }
}

/**
 * SYNC_STATE: Write remote hashes atomically (tmp + rename). Non-throwing.
 * Failure degrades remoteAhead detection but does not fail the pull.
 */
async function writeSyncState(localDir: string, hashes: Map<string, string>): Promise<void> {
  const statePath = path.join(localDir, SYNC_STATE_FILE);
  const tempPath = `${statePath}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(Object.fromEntries(hashes), null, 2), 'utf-8');
    await fs.rename(tempPath, statePath);
  } catch (error: unknown) {
    console.error(`[rsync] Failed to write sync state: ${(error as Error).message}`);
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
  }
}

/** Ensure SYNC_STATE_FILE is listed in .gitignore (operational data, not source). */
async function ensureSyncStateGitignored(localDir: string): Promise<void> {
  const gitignorePath = path.join(localDir, '.gitignore');
  try {
    let content = '';
    try { content = await fs.readFile(gitignorePath, 'utf-8'); } catch { /* will create */ }
    if (!content.includes(SYNC_STATE_FILE)) {
      const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      await fs.writeFile(gitignorePath, `${content}${prefix}${SYNC_STATE_FILE}\n`, 'utf-8');
    }
  } catch (error: unknown) {
    console.error(`[rsync] Failed to update .gitignore: ${(error as Error).message}`);
  }
}

// --- Helpers ---

/** Get the file extension for a GAS file type */
function getExtension(type: GASFile['type']): string {
  switch (type) {
    case 'SERVER_JS': return '.gs';
    case 'HTML': return '.html';
    case 'JSON': return '.json';
    default: return '.gs';
  }
}

/** Infer GAS file type from local filename */
function inferType(filename: string): GASFile['type'] {
  if (filename.endsWith('.html')) return 'HTML';
  if (filename.endsWith('.json')) return 'JSON';
  return 'SERVER_JS';
}

/** Strip extension to get GAS file name */
function stripExtension(filename: string): string {
  return filename.replace(/\.(gs|html|json)$/, '');
}

/** Read all local .gs/.html/.json files in a directory */
async function readLocalFiles(localDir: string): Promise<Map<string, { source: string; type: GASFile['type']; filename: string }>> {
  const entries = await fs.readdir(localDir);
  const files = new Map<string, { source: string; type: GASFile['type']; filename: string }>();

  for (const entry of entries) {
    if (!entry.endsWith('.gs') && !entry.endsWith('.html') && !entry.endsWith('.json')) continue;
    if (entry === 'gas-deploy.json') continue; // skip our config file
    if (entry === SYNC_STATE_FILE) continue;   // skip operational state file

    const source = await fs.readFile(path.join(localDir, entry), 'utf-8');
    const name = stripExtension(entry);
    files.set(name, { source, type: inferType(entry), filename: entry });
  }

  return files;
}

// --- Core operations ---

/**
 * HASH_MISMATCH: Compare local files vs remote files using Git SHA-1 hashes.
 * Uses sync state (recorded at last pull) to determine change direction:
 *   - localAhead:  local changed since pull (needs push)
 *   - remoteAhead: remote changed since pull (needs pull)
 *   - both non-empty: diverged — callers check localAhead && remoteAhead to halt
 * Without state (no pull yet): all hash diffs treated as localAhead (safe fallback).
 */
export async function getStatus(
  scriptId: string,
  localDir: string,
  fileOps: GASFileOperations
): Promise<SyncStatus> {
  // If localDir doesn't exist, everything is remote-only
  let localExists = true;
  try {
    await fs.access(localDir);
  } catch {
    localExists = false;
  }

  const remoteFiles = await fileOps.getProjectFiles(scriptId);
  const remoteMap = new Map<string, GASFile>();
  for (const f of remoteFiles) {
    remoteMap.set(f.name, f);
  }

  if (!localExists) {
    return {
      inSync: [],
      localAhead: [],
      remoteAhead: [],
      localOnly: [],
      remoteOnly: Array.from(remoteMap.values()).map(f => ({ name: f.name, remoteHash: gitBlobSha1(f.source ?? '') })),
    };
  }

  const localFiles = await readLocalFiles(localDir);

  // SYNC_STATE: Load last pull state for directional comparison
  const state = await readSyncState(localDir);

  const inSync: FileStatus[] = [];
  const localAhead: FileStatus[] = [];
  const remoteAhead: FileStatus[] = [];
  const localOnly: FileStatus[] = [];
  const remoteOnly: FileStatus[] = [];

  // Compare files present locally
  for (const [name, local] of localFiles) {
    const remote = remoteMap.get(name);
    const localHash = gitBlobSha1(local.source);

    if (!remote) {
      localOnly.push({ name, localHash });
      continue;
    }

    const remoteHash = gitBlobSha1(remote.source ?? '');

    if (localHash === remoteHash) {
      inSync.push({ name, localHash, remoteHash });
      remoteMap.delete(name);
      continue;
    }

    // HASH_MISMATCH: local and remote differ — use state to determine direction
    if (state !== null) {
      const stateHash = state.get(name);
      const localChanged = localHash !== stateHash;   // local modified since last pull
      const remoteChanged = remoteHash !== stateHash; // remote modified since last pull

      if (localChanged) localAhead.push({ name, localHash, remoteHash });
      if (remoteChanged) remoteAhead.push({ name, remoteHash, localHash });
      // Both changed → diverged — divergence guard in callers fires on localAhead && remoteAhead
    } else {
      // No state file (first pull not done) — fall back: all diffs → localAhead
      localAhead.push({ name, localHash, remoteHash });
    }

    remoteMap.delete(name);
  }

  // Remaining remote files not found locally
  for (const [name, remote] of remoteMap) {
    remoteOnly.push({ name, remoteHash: gitBlobSha1(remote.source ?? '') });
  }

  return { inSync, localAhead, remoteAhead, localOnly, remoteOnly };
}

/**
 * Pull all files from GAS to local directory.
 * Creates the directory if it doesn't exist. Writes files AS-IS.
 * Records remote hashes in SYNC_STATE_FILE to enable directional status tracking.
 */
export async function pull(
  scriptId: string,
  localDir: string,
  fileOps: GASFileOperations
): Promise<PullResult> {
  try {
    await fs.mkdir(localDir, { recursive: true });

    const remoteFiles = await fileOps.getProjectFiles(scriptId);
    const pulled: string[] = [];

    for (const file of remoteFiles) {
      const ext = getExtension(file.type);
      const filename = `${file.name}${ext}`;
      await fs.writeFile(path.join(localDir, filename), file.source ?? '', 'utf-8');
      pulled.push(filename);
    }

    // SYNC_STATE: Record remote hashes so getStatus can detect change direction.
    // writeSyncState is non-throwing — failure degrades remoteAhead detection only.
    const remoteHashes = new Map(remoteFiles.map(f => [f.name, gitBlobSha1(f.source ?? '')]));
    await writeSyncState(localDir, remoteHashes);
    await ensureSyncStateGitignored(localDir);

    // Auto-init git if not already
    try {
      await fs.access(path.join(localDir, '.git'));
    } catch {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: localDir });
      await execFileAsync('git', ['add', '-A'], { cwd: localDir });
      await execFileAsync('git', ['commit', '-m', 'Initial pull from GAS'], { cwd: localDir });
    }

    return { success: true, filesPulled: pulled };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, filesPulled: [], error: message };
  }
}

/**
 * LOCK_GUARD + AUTO_PUSH: Validate and push local files to GAS.
 * Only pushes files where local hash != remote hash.
 * Uses a per-scriptId lock to prevent concurrent push race conditions.
 */
export async function push(
  scriptId: string,
  localDir: string,
  fileOps: GASFileOperations,
  options: { dryRun?: boolean; skipValidation?: boolean } = {}
): Promise<PushResult> {
  return withPushLock(scriptId, async () => {
    try {
      // Read local files
      const localFiles = await readLocalFiles(localDir);

      if (localFiles.size === 0) {
        return { success: false, filesPushed: [], error: 'No .gs/.html/.json files found in local directory' };
      }

      // Validate CommonJS structure (unless skipped)
      if (!options.skipValidation) {
        const filesToValidate = Array.from(localFiles.entries()).map(([name, f], i) => ({
          name: f.filename,
          source: f.source,
          position: i,
        }));

        const validationErrors = validateFilesErrors(filesToValidate);
        if (validationErrors.length > 0) {
          return {
            success: false,
            filesPushed: [],
            validationErrors,
            error: `Validation failed for ${validationErrors.length} file(s)`,
          };
        }
      }

      // Get remote files for hash comparison
      const remoteFiles = await fileOps.getProjectFiles(scriptId);
      const remoteMap = new Map<string, GASFile>();
      for (const f of remoteFiles) {
        remoteMap.set(f.name, f);
      }

      // Build the full file set (remote base + local changes)
      const fileSet: GASFile[] = [];
      const changedFiles: string[] = [];

      // Add/update from local
      for (const [name, local] of localFiles) {
        const remote = remoteMap.get(name);
        const localHash = gitBlobSha1(local.source);
        const remoteHash = remote ? gitBlobSha1(remote.source ?? '') : null;

        if (localHash !== remoteHash) {
          changedFiles.push(name);
        }

        fileSet.push({
          name,
          type: local.type,
          source: local.source,
        });

        remoteMap.delete(name);
      }

      // Keep remote-only files (don't delete them)
      for (const [, remote] of remoteMap) {
        fileSet.push(remote);
      }

      if (changedFiles.length === 0) {
        return { success: true, filesPushed: [], error: undefined };
      }

      if (options.dryRun) {
        return { success: true, filesPushed: changedFiles };
      }

      // Push all files to GAS (API requires full file set)
      await fileOps.updateProjectFiles(scriptId, fileSet);

      return { success: true, filesPushed: changedFiles };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, filesPushed: [], error: message };
    }
  });
}
