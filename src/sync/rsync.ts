/**
 * Sync Engine for mcp_gas_deploy
 *
 * Handles pull (GAS → local), push (local → GAS with validation), and
 * status diffing between local and remote files by name and content hash.
 *
 * Navigation comments:
 * - AUTO_PUSH: where push is triggered before exec
 * - LOCK_GUARD: where concurrent push protection applies
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { validateFilesErrors, type ValidationResult } from '../validation/commonjsValidator.js';
import type { GASFile } from '../api/gasTypes.js';

const execFileAsync = promisify(execFile);

// --- Types ---

export interface SyncStatus {
  localOnly: FileStatus[];   // present locally, not on remote
  remoteOnly: FileStatus[];  // present on remote, not locally
  both: FileStatus[];        // present on both sides, content same
  modified: FileStatus[];    // present on both sides, content differs
}

export interface FileStatus { name: string; }

export interface PushResult {
  success: boolean;
  filesPushed: string[];
  validationErrors?: ValidationResult[];
  error?: string;
  mergeSkipped?: boolean;
  gitArchived?: boolean;
  archivedFiles?: string[];
}

interface GitArchiveResult {
  archived: boolean;
  archivedFiles: string[];
  error?: string;
}

export interface PullResult {
  success: boolean;
  filesPulled: string[];
  error?: string;
}

// --- File-level push lock (LOCK_GUARD — prevents concurrent push race) ---

const pushLocks = new Map<string, Promise<void>>();

async function withPushLock<T>(scriptId: string, fn: () => Promise<T>): Promise<T> {
  // Wait for existing lock on this scriptId
  while (pushLocks.has(scriptId)) {
    await pushLocks.get(scriptId);
  }

  let resolve: () => void = () => { /* replaced by Promise constructor */ };
  const lockPromise = new Promise<void>(r => { resolve = r; });
  pushLocks.set(scriptId, lockPromise);

  try {
    return await fn();
  } finally {
    pushLocks.delete(scriptId);
    resolve();
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

/**
 * Normalize file content and compute SHA256 hash.
 * Normalizes CRLF → LF to match GAS server-side normalization,
 * preventing spurious diff reports from line-ending differences.
 */
function hashContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/** Extract folder path from a GAS file name (e.g. "common-js/utils" → "common-js"). */
function getFolderFromName(name: string): string {
  const lastSlash = name.lastIndexOf('/');
  return lastSlash === -1 ? '' : name.substring(0, lastSlash);
}

/** Priority within common-js/: ConfigManager=1, __mcp_exec=2, other common-js=3, non-common-js=4 */
function getCommonJsPriority(name: string): number {
  if (name === 'common-js/ConfigManager') return 1;
  if (name === 'common-js/__mcp_exec') return 2;
  if (name.startsWith('common-js/')) return 3;
  return 4;
}

/** Returns true if the file uses loadNow: true (eager execution at parse time). */
function isLoadNow(f: GASFile): boolean {
  const src = f.source ?? '';
  return /__defineModule__\s*\(\s*_main\s*,\s*true\s*\)/.test(src) ||
    /__defineModule__\s*\(\s*_main\s*,\s*\{[^}]*loadNow\s*:\s*true[^}]*\}\s*\)/.test(src);
}

/**
 * Order files for push: three-bucket partitioning (known → new → manifest).
 *
 * Uses remote file positions as a template to preserve existing order,
 * appends new files grouped by folder with common-js/ prioritized,
 * and ensures appsscript manifest is always last.
 */
export function orderFilesForPush(fileSet: GASFile[], remoteFiles: GASFile[]): GASFile[] {
  if (fileSet.length === 0) return [];

  const remotePositions = new Map<string, number>();
  for (const rf of remoteFiles) {
    remotePositions.set(rf.name, rf.position ?? Number.MAX_SAFE_INTEGER);
  }

  const manifest: GASFile[] = [];
  const knownFiles: GASFile[] = [];
  const newFiles: GASFile[] = [];

  for (const file of fileSet) {
    if (file.name === 'appsscript') {
      manifest.push(file);
    } else if (remotePositions.has(file.name)) {
      knownFiles.push(file);
    } else {
      newFiles.push(file);
    }
  }

  // Known files: preserve remote order, but always pin require to position 0
  knownFiles.sort((a, b) => {
    const aIsRequire = a.name === 'require' || a.name.endsWith('/require');
    const bIsRequire = b.name === 'require' || b.name.endsWith('/require');
    if (aIsRequire && !bIsRequire) return -1;
    if (!aIsRequire && bIsRequire) return 1;
    return remotePositions.get(a.name)! - remotePositions.get(b.name)!;
  });

  // New files: tiered priority sort
  newFiles.sort((a, b) => {
    // Tier 0: require always first
    const aIsRequire = a.name === 'require' || a.name.endsWith('/require');
    const bIsRequire = b.name === 'require' || b.name.endsWith('/require');
    if (aIsRequire && !bIsRequire) return -1;
    if (!aIsRequire && bIsRequire) return 1;

    // Tier 1: common-js/ before other folders, with critical infra pinned
    const aCommonJsPriority = getCommonJsPriority(a.name);
    const bCommonJsPriority = getCommonJsPriority(b.name);
    if (aCommonJsPriority !== bCommonJsPriority) return aCommonJsPriority - bCommonJsPriority;

    // Tier 2: group by folder — root-level (no folder prefix) appended after folder-prefixed files
    const aFolder = getFolderFromName(a.name);
    const bFolder = getFolderFromName(b.name);
    const aHasFolder = aFolder !== '';
    const bHasFolder = bFolder !== '';
    if (aHasFolder !== bHasFolder) return aHasFolder ? -1 : 1;
    if (aFolder !== bFolder) return aFolder < bFolder ? -1 : 1;

    // Tier 3: stable — preserve insertion order
    return 0;
  });

  const ordered = [...knownFiles, ...newFiles];
  const nonLoadNow = ordered.filter(f => !isLoadNow(f));
  const loadNowFiles = ordered.filter(f => isLoadNow(f));

  return [...nonLoadNow, ...loadNowFiles, ...manifest];
}

/** Read all local .gs/.html/.json files in a directory (recursive). */
async function readLocalFiles(
  localDir: string,
  prefix: string = ''
): Promise<Map<string, { source: string; type: GASFile['type']; filename: string }>> {
  const entries = await fs.readdir(localDir, { withFileTypes: true });
  const files = new Map<string, { source: string; type: GASFile['type']; filename: string }>();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip hidden directories (e.g., .git)
      if (entry.name.startsWith('.')) continue;
      const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const subFiles = await readLocalFiles(path.join(localDir, entry.name), subPrefix);
      for (const [name, file] of subFiles) {
        files.set(name, file);
      }
      continue;
    }

    const entryName = entry.name;
    // Skip hidden files (e.g., .gas-sync-state.json, .gitignore)
    if (entryName.startsWith('.')) continue;
    if (!entryName.endsWith('.gs') && !entryName.endsWith('.html') && !entryName.endsWith('.json')) continue;

    // Skip operational/config files at root level only
    if (!prefix) {
      if (entryName === 'gas-deploy.json') continue;
    }

    const source = await fs.readFile(path.join(localDir, entryName), 'utf-8');
    const baseName = stripExtension(entryName);
    const name = prefix ? `${prefix}/${baseName}` : baseName;
    const filename = prefix ? `${prefix}/${entryName}` : entryName;
    files.set(name, { source, type: inferType(entryName), filename });
  }

  return files;
}

// --- Git archive ---

/**
 * Archive remote-only GAS files in git history before they can be lost.
 *
 * Two-commit pattern: writes remote-only files to disk and commits them,
 * then deletes them and commits the removal — restoring the working tree
 * to its original state. This creates a recoverable trail via `git show`
 * or `git log --diff-filter=A -- <filename>`.
 *
 * Assumes exclusive access to localDir's git working tree (guaranteed by
 * withPushLock when each scriptId maps to a unique localDir).
 */
async function gitArchiveRemoteOnly(
  localDir: string,
  remoteOnlyFiles: GASFile[]
): Promise<GitArchiveResult> {
  // Early return: no files to archive
  if (remoteOnlyFiles.length === 0) {
    return { archived: false, archivedFiles: [] };
  }

  // Early return: no .git directory — git not initialized
  try {
    await fs.access(path.join(localDir, '.git'));
  } catch {
    return { archived: false, archivedFiles: [] };
  }

  // Early return: git not available
  try {
    await execFileAsync('git', ['--version'], { cwd: localDir, timeout: 10000 });
  } catch {
    return { archived: false, archivedFiles: [] };
  }

  const writtenPaths: string[] = [];
  const archivedNames: string[] = [];
  try {
    // Write each remote-only file to disk with correct extension
    for (const file of remoteOnlyFiles) {
      const ext = getExtension(file.type);
      const filename = `${file.name}${ext}`;
      const filePath = path.join(localDir, filename);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // Guard: remoteOnlyFiles filter should prevent this, but never overwrite local files
      try {
        await fs.access(filePath);
        // File exists — bail out of archive entirely to protect local state
        return { archived: false, archivedFiles: [], error: `Archive skipped: ${filename} already exists locally` };
      } catch {
        // ENOENT — safe to write
      }
      await fs.writeFile(filePath, file.source ?? '', 'utf-8');
      writtenPaths.push(filePath);
      archivedNames.push(file.name);
    }

    // Commit the archived files (only the paths we wrote — not unrelated working tree changes)
    await execFileAsync('git', ['add', '--', ...writtenPaths], { cwd: localDir, timeout: 10000 });
    await execFileAsync(
      'git',
      ['commit', '-m', `gas-archive: ${remoteOnlyFiles.length} remote-only file(s) from GAS`],
      { cwd: localDir, timeout: 10000 }
    );

    // Remove the archived files and commit the removal
    for (const filePath of writtenPaths) {
      await fs.unlink(filePath);
    }
    await execFileAsync('git', ['add', '--', ...writtenPaths], { cwd: localDir, timeout: 10000 });
    await execFileAsync(
      'git',
      ['commit', '-m', 'gas-archive: removed archived files'],
      { cwd: localDir, timeout: 10000 }
    );

    return { archived: true, archivedFiles: archivedNames };
  } catch (error: unknown) {
    // Best-effort cleanup: remove any files we wrote to restore working tree
    for (const filePath of writtenPaths) {
      try { await fs.unlink(filePath); } catch { /* may already be deleted */ }
    }
    // Best-effort: reset any staged changes
    try {
      await execFileAsync('git', ['reset', 'HEAD'], { cwd: localDir, timeout: 10000 });
    } catch { /* non-fatal */ }
    const message = error instanceof Error ? error.message : String(error);
    return { archived: false, archivedFiles: [], error: message };
  }
}

// --- Core operations ---

/**
 * Compare local files vs remote files by name AND content hash.
 * Classifies into:
 *   localOnly  — present locally, not on remote
 *   remoteOnly — present on remote, not locally
 *   both       — present on both sides with identical content
 *   modified   — present on both sides but content differs
 */
export async function getStatus(
  scriptId: string,
  localDir: string,
  fileOps: GASFileOperations
): Promise<SyncStatus> {
  let localExists = true;
  try {
    await fs.access(localDir);
  } catch {
    localExists = false;
  }

  const remoteFiles = await fileOps.getProjectFiles(scriptId);
  const remoteByName = new Map(remoteFiles.map(f => [f.name, f]));

  if (!localExists) {
    return {
      localOnly: [],
      remoteOnly: Array.from(remoteByName.keys()).map(name => ({ name })),
      both: [],
      modified: [],
    };
  }

  const localFiles = await readLocalFiles(localDir);
  const localNames = new Set(localFiles.keys());

  const localOnly: FileStatus[] = [];
  const remoteOnly: FileStatus[] = [];
  const both: FileStatus[] = [];
  const modified: FileStatus[] = [];

  for (const name of localNames) {
    if (remoteByName.has(name)) {
      const remoteFile = remoteByName.get(name)!;
      const localFile = localFiles.get(name)!;
      const localHash = hashContent(localFile.source);
      const remoteHash = hashContent(remoteFile.source ?? '');
      if (localHash === remoteHash) {
        both.push({ name });
      } else {
        modified.push({ name });
      }
    } else {
      localOnly.push({ name });
    }
  }

  for (const name of remoteByName.keys()) {
    if (!localNames.has(name)) {
      remoteOnly.push({ name });
    }
  }

  return { localOnly, remoteOnly, both, modified };
}

/**
 * Pull all files from GAS to local directory.
 * Creates the directory if it doesn't exist. Writes files AS-IS.
 * Cleans up orphaned .gas-sync-state.json on first pull after upgrade.
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
      const filePath = path.join(localDir, filename);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.source ?? '', 'utf-8');
      pulled.push(filename);
    }

    // One-time cleanup: remove orphaned state file from pre-simplification versions.
    try { await fs.unlink(path.join(localDir, '.gas-sync-state.json')); } catch { /* ENOENT is fine */ }

    // Auto-init git if not already (best-effort — failure does not fail the pull)
    try {
      await fs.access(path.join(localDir, '.git'));
    } catch {
      try {
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: localDir, timeout: 10000 });
        await execFileAsync('git', ['add', '-A'], { cwd: localDir, timeout: 10000 });
        await execFileAsync('git', ['commit', '-m', 'Initial pull from GAS'], { cwd: localDir, timeout: 10000 });
      } catch {
        /* git not available or init failed — non-fatal, files are already written */
      }
    }

    return { success: true, filesPulled: pulled };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, filesPulled: [], error: message };
  }
}

/**
 * LOCK_GUARD + AUTO_PUSH: Validate and push local files to GAS.
 *
 * prune=false (default): MERGE — fetches remote files and preserves remote-only
 * files by including them in the push payload. Safe default that prevents
 * accidental deletion of GAS files not present locally.
 *
 * prune=true: REPLACE — pushes only local files. Remote-only files are removed
 * from GAS (GAS API atomically replaces all files). Use explicitly when you
 * want to clean up ghost files on the remote.
 *
 * Uses a per-scriptId lock to prevent concurrent push race conditions.
 */
export async function push(
  scriptId: string,
  localDir: string,
  fileOps: GASFileOperations,
  options: { dryRun?: boolean; skipValidation?: boolean; prune?: boolean } = {}
): Promise<PushResult> {
  return withPushLock(scriptId, async () => {
    try {
      const localFiles = await readLocalFiles(localDir);

      if (localFiles.size === 0) {
        return { success: false, filesPushed: [], error: 'No .gs/.html/.json files found in local directory' };
      }

      // Build the file set from local files
      const fileSet: GASFile[] = [];
      const gsFilesForValidation: Array<{ name: string; source: string; position: number }> = [];
      const allLocalNames: string[] = [];

      for (const [name, local] of localFiles) {
        fileSet.push({ name, type: local.type, source: local.source });
        if (local.type === 'SERVER_JS') {
          gsFilesForValidation.push({ name: local.filename, source: local.source, position: gsFilesForValidation.length });
        }
        allLocalNames.push(name);
      }

      // Fetch remote files unconditionally — needed for merge, git archive, and ordering.
      let mergeSkipped = false;
      let remoteFiles: GASFile[] = [];
      let remoteOnlyFiles: GASFile[] = [];
      let gitArchived = false;
      let archivedFiles: string[] = [];
      try {
        remoteFiles = await fileOps.getProjectFiles(scriptId);
        const localNameSet = new Set(localFiles.keys());
        remoteOnlyFiles = remoteFiles.filter(f => !localNameSet.has(f.name));
      } catch {
        // Non-fatal — if remote fetch fails, proceed with local-only push
        mergeSkipped = true;
        console.error('[push] Could not fetch remote files for merge; proceeding with local-only push');
      }

      // Archive remote-only files in git before they can be lost (skipped on dryRun)
      if (!options.dryRun && remoteOnlyFiles.length > 0) {
        const archiveResult = await gitArchiveRemoteOnly(localDir, remoteOnlyFiles);
        gitArchived = archiveResult.archived;
        archivedFiles = archiveResult.archivedFiles;
      }

      // MERGE behavior (prune=false, default): preserve remote-only files in push payload.
      if (!options.prune) {
        for (const remoteFile of remoteOnlyFiles) {
          fileSet.push({ name: remoteFile.name, type: remoteFile.type, source: remoteFile.source ?? '' });
        }
      }

      // Order files: preserve remote positions, group new files by folder, appsscript last.
      const orderedFiles = orderFilesForPush(fileSet, remoteFiles);

      if (options.dryRun) {
        return { success: true, filesPushed: allLocalNames, mergeSkipped, gitArchived, archivedFiles };
      }

      // Validate using ordered positions so REQUIRE_POSITION reflects the actual push sequence.
      // Raw local iteration order is alphabetical and does not guarantee require.gs is first;
      // orderedFiles from orderFilesForPush always places require at position 0.
      if (!options.skipValidation) {
        const gsForValidation = orderedFiles
          .filter(f => f.type === 'SERVER_JS')
          .map((f, i) => ({ name: f.name, source: f.source ?? '', position: i }));
        if (gsForValidation.length > 0) {
          const validationErrors = validateFilesErrors(gsForValidation);
          if (validationErrors.length > 0) {
            return {
              success: false,
              filesPushed: [],
              validationErrors,
              error: `Validation failed for ${validationErrors.length} file(s)`,
            };
          }
        }
      }

      await fileOps.updateProjectFiles(scriptId, orderedFiles);

      return { success: true, filesPushed: allLocalNames, mergeSkipped, gitArchived, archivedFiles };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, filesPushed: [], error: message };
    }
  });
}
