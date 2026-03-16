/**
 * .claspignore support for mcp-gas-deploy
 *
 * Parses .claspignore (gitignore-style patterns) using the `ignore` library.
 * Applied AFTER hardcoded filters (hidden files, extension whitelist, gas-deploy.json)
 * so .claspignore can only narrow the set further — it cannot include excluded files.
 *
 * Scope: push, status, preview (via readLocalFiles). Pull is NOT filtered.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

export interface ClaspIgnoreResult {
  /** Returns true if the file should be INCLUDED. Path is relative to localDir. */
  accepts: (relativePath: string) => boolean;
  /** true when .claspignore was found and loaded */
  active: boolean;
  /** Number of non-comment, non-blank patterns */
  patternCount: number;
}

/**
 * Load and parse .claspignore from a local directory.
 * Returns a no-op filter when the file doesn't exist.
 */
export async function loadClaspIgnore(localDir: string): Promise<ClaspIgnoreResult> {
  const filePath = path.join(localDir, '.claspignore');

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // ENOENT or any read error — no .claspignore
    return {
      accepts: () => true,
      active: false,
      patternCount: 0,
    };
  }

  const ig = ignore().add(content);

  // Count non-comment, non-blank patterns
  const patternCount = content
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    }).length;

  return {
    accepts: (relativePath: string) => !ig.ignores(relativePath),
    active: true,
    patternCount,
  };
}
