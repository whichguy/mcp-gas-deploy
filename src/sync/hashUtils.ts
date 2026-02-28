/**
 * Hash utilities for mcp_gas_deploy
 *
 * Git SHA-1 hash computation for file content comparison.
 * The algorithm matches the remote GAS comparison baseline used by mcp_gas:
 * SHA-1 of `"blob " + byte_length + "\0" + content` — this is the same hash
 * git uses for blob objects, enabling direct comparison with remote hashes.
 */

import { createHash } from 'node:crypto';

/**
 * Compute the Git blob SHA-1 hash for a string of content.
 * Format: sha1("blob <byte_length>\0<content>")
 */
export function gitBlobSha1(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  const header = `blob ${buf.length}\0`;
  return createHash('sha1')
    .update(header)
    .update(buf)
    .digest('hex');
}

/**
 * Compute SHA-256 hash of content (for integrity checks).
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
