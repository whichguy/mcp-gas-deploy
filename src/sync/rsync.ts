/**
 * Sync Engine for mcp_gas_deploy
 *
 * Handles pull (GAS → local), push (local → GAS with validation), and
 * status diffing between local and remote files by name.
 *
 * Navigation comments:
 * - AUTO_PUSH: where push is triggered before exec
 * - LOCK_GUARD: where concurrent push protection applies
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { validateFilesErrors, type ValidationResult } from '../validation/commonjsValidator.js';
import type { GASFile } from '../api/gasTypes.js';

// --- Types ---

export interface SyncStatus {
  localOnly: FileStatus[];   // present locally, not on remote
  remoteOnly: FileStatus[];  // present on remote, not locally
  both: FileStatus[];        // present on both sides
}

export interface FileStatus { name: string; }

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

// --- File-level push lock (LOCK_GUARD — prevents concurrent push race) ---

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

// --- Core operations ---

/**
 * Compare local files vs remote files by name.
 * Classifies into localOnly (local only), remoteOnly (remote only), both (present on both sides).
 * No hash computation — name-only comparison.
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
  const remoteNames = new Set(remoteFiles.map(f => f.name));

  if (!localExists) {
    return {
      localOnly: [],
      remoteOnly: Array.from(remoteNames).map(name => ({ name })),
      both: [],
    };
  }

  const localFiles = await readLocalFiles(localDir);
  const localNames = new Set(localFiles.keys());

  const localOnly: FileStatus[] = [];
  const remoteOnly: FileStatus[] = [];
  const both: FileStatus[] = [];

  for (const name of localNames) {
    if (remoteNames.has(name)) {
      both.push({ name });
    } else {
      localOnly.push({ name });
    }
  }

  for (const name of remoteNames) {
    if (!localNames.has(name)) {
      remoteOnly.push({ name });
    }
  }

  return { localOnly, remoteOnly, both };
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
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: localDir });
        await execFileAsync('git', ['add', '-A'], { cwd: localDir });
        await execFileAsync('git', ['commit', '-m', 'Initial pull from GAS'], { cwd: localDir });
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
 * LOCK_GUARD + AUTO_PUSH: Validate and push all local files to GAS.
 * Always pushes ALL local files unconditionally.
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
      const localFiles = await readLocalFiles(localDir);

      if (localFiles.size === 0) {
        return { success: false, filesPushed: [], error: 'No .gs/.html/.json files found in local directory' };
      }

      // Build the full file set from all local files
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

      // GAS requires the CommonJS runtime (require / common-js/require) at position 0.
      fileSet.sort((a, b) => {
        const aIsRequire = a.name === 'require' || a.name.endsWith('/require');
        const bIsRequire = b.name === 'require' || b.name.endsWith('/require');
        if (aIsRequire && !bIsRequire) return -1;
        if (!aIsRequire && bIsRequire) return 1;
        return 0;
      });

      if (options.dryRun) {
        return { success: true, filesPushed: allLocalNames };
      }

      // Validate all .gs files before pushing
      if (!options.skipValidation && gsFilesForValidation.length > 0) {
        const validationErrors = validateFilesErrors(gsFilesForValidation);
        if (validationErrors.length > 0) {
          return {
            success: false,
            filesPushed: [],
            validationErrors,
            error: `Validation failed for ${validationErrors.length} file(s)`,
          };
        }
      }

      await fileOps.updateProjectFiles(scriptId, fileSet);

      return { success: true, filesPushed: allLocalNames };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, filesPushed: [], error: message };
    }
  });
}
