/**
 * Manifest utilities for GAS appsscript.json manipulation.
 * Pure functions — no API calls, no side-effects.
 */

import type { GASFile } from '../api/gasTypes.js';

/**
 * Read and parse appsscript.json from a GASFile array.
 * Returns parsed manifest object, or null if not found.
 */
export function parseManifest(files: GASFile[]): Record<string, unknown> | null {
  const manifestFile = files.find(f => f.name === 'appsscript');
  if (!manifestFile?.source) return null;
  try {
    return JSON.parse(manifestFile.source) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Ensure appsscript.json has executionApi.access set to 'MYSELF'.
 * Returns updated file array and whether any change was made.
 * Caller decides whether to push the updated files.
 */
export function ensureExecutionApi(files: GASFile[]): { files: GASFile[]; updated: boolean } {
  const manifestIndex = files.findIndex(f => f.name === 'appsscript');
  if (manifestIndex === -1) {
    return { files, updated: false };
  }

  const manifestFile = files[manifestIndex];
  if (!manifestFile.source) {
    return { files, updated: false };
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestFile.source) as Record<string, unknown>;
  } catch {
    return { files, updated: false };
  }

  // Check if already set correctly
  const executionApi = manifest.executionApi as Record<string, unknown> | undefined;
  if (executionApi?.access === 'MYSELF') {
    return { files, updated: false };
  }

  // Set executionApi.access = 'MYSELF'
  const updatedManifest = {
    ...manifest,
    executionApi: {
      ...(typeof manifest.executionApi === 'object' && manifest.executionApi !== null
        ? (manifest.executionApi as Record<string, unknown>)
        : {}),
      access: 'MYSELF',
    },
  };

  const updatedFiles = files.map((f, i) =>
    i === manifestIndex
      ? { ...f, source: JSON.stringify(updatedManifest, null, 2) }
      : f
  );

  return { files: updatedFiles, updated: true };
}
