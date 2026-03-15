/**
 * Project resolution utility for mcp-gas-deploy
 *
 * Centralizes the scriptId + localDir resolution logic that was previously
 * duplicated across 8+ tool handlers. All tools call resolveProject() to
 * determine the scriptId and localDir from a combination of explicit params
 * and .clasp.json on disk.
 *
 * Resolution cascade (in priority order):
 *   1. localDir provided + has .clasp.json → read scriptId from it (explicit scriptId overrides)
 *   2. localDir provided + no .clasp.json + scriptId provided → use explicit scriptId
 *   3. localDir omitted + scriptId provided → use CWD (check .clasp.json there too)
 *   4. Neither provided → error with actionable hint
 *
 * Path traversal guard: resolved localDir must be within the user's home directory.
 * scriptId validation: must match SCRIPT_ID_PATTERN (20+ alphanumeric/hyphen/underscore).
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { SCRIPT_ID_PATTERN } from './validation.js';

export type ResolvedFrom = 'explicit' | 'clasp-json';

export interface ResolvedProject {
  scriptId: string;
  localDir: string;
  /** true when explicit scriptId differs from what's in .clasp.json — callers should NOT update .clasp.json */
  isOverride: boolean;
  /** How the scriptId was resolved: 'explicit' (provided by caller), 'clasp-json' (read from .clasp.json) */
  resolvedFrom: ResolvedFrom;
  warnings?: string[];
}

/**
 * Read .clasp.json from a directory and extract the scriptId.
 * Returns null if the file is missing, unreadable, or contains an invalid scriptId.
 */
export async function readClaspJson(dir: string): Promise<{ scriptId: string } | null> {
  try {
    const content = await fs.readFile(path.join(dir, '.clasp.json'), 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const scriptId = parsed.scriptId;
    if (typeof scriptId !== 'string' || scriptId.length === 0) return null;
    if (!SCRIPT_ID_PATTERN.test(scriptId)) return null;
    return { scriptId };
  } catch {
    return null;
  }
}

/**
 * Resolve scriptId and localDir from a combination of explicit params and .clasp.json.
 *
 * @throws Error with actionable message when resolution fails (invalid scriptId,
 *         path traversal, neither param provided, or malformed .clasp.json with no fallback).
 */
export async function resolveProject(params: {
  scriptId?: string;
  localDir?: string;
}): Promise<ResolvedProject> {
  const { scriptId: explicitScriptId, localDir: explicitLocalDir } = params;

  // Case 4: Neither provided → error
  if (!explicitScriptId && !explicitLocalDir) {
    throw new Error(
      'Either scriptId or localDir (containing .clasp.json) is required. ' +
      'Provide scriptId explicitly, or point localDir to a directory with .clasp.json.'
    );
  }

  // Resolve localDir — expand ~ and resolve to absolute path
  let resolvedDir: string;
  if (explicitLocalDir) {
    resolvedDir = explicitLocalDir.startsWith('~')
      ? path.join(os.homedir(), explicitLocalDir.slice(1))
      : path.resolve(explicitLocalDir);
  } else {
    // Case 3: localDir omitted + scriptId provided → use CWD
    // scriptId is guaranteed non-empty here (Case 4 already handled)
    resolvedDir = process.cwd();
  }

  // Path traversal guard — resolved path must be within home directory
  const homedir = os.homedir();
  if (!resolvedDir.startsWith(homedir + path.sep) && resolvedDir !== homedir) {
    throw new Error(
      'localDir must resolve within your home directory. ' +
      `Got: ${resolvedDir}. Use an absolute path within ~/ or omit localDir.`
    );
  }

  // Try reading .clasp.json from resolvedDir (covers both explicit localDir and CWD fallback)
  const clasp = await readClaspJson(resolvedDir);

  if (explicitScriptId) {
    // Validate explicit scriptId format
    if (!SCRIPT_ID_PATTERN.test(explicitScriptId)) {
      throw new Error(
        `Invalid scriptId format: "${explicitScriptId}". ` +
        'scriptId must be 20+ alphanumeric characters, hyphens, or underscores.'
      );
    }

    // isOverride: explicit scriptId differs from .clasp.json
    const isOverride = clasp !== null && clasp.scriptId !== explicitScriptId;
    const warnings: string[] = [];
    if (isOverride) {
      warnings.push(
        `Explicit scriptId (${explicitScriptId}) differs from .clasp.json (${clasp.scriptId}). ` +
        'Using explicit scriptId. Use pull or push with reparent=true to update .clasp.json.'
      );
    }

    return {
      scriptId: explicitScriptId,
      localDir: resolvedDir,
      isOverride,
      resolvedFrom: 'explicit',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // No explicit scriptId — must come from .clasp.json
  if (clasp) {
    // Case 1: localDir provided + has .clasp.json → read scriptId from it
    return {
      scriptId: clasp.scriptId,
      localDir: resolvedDir,
      isOverride: false,
      resolvedFrom: 'clasp-json',
    };
  }

  // Case 2 fallthrough: localDir provided + no .clasp.json + no scriptId → error
  throw new Error(
    `No scriptId provided and no .clasp.json found in ${resolvedDir}. ` +
    'Either provide scriptId explicitly or run pull first to create .clasp.json.'
  );
}
