/**
 * Ls Tool for mcp-gas-deploy
 *
 * Lists files in a Google Apps Script project (metadata only — no source).
 * Supports optional filtering by file name (substring or regex) and file type.
 * Returns files sorted by GAS execution position.
 */

import type { GASFileOperations } from '../api/gasFileOperations.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';

export interface LsToolParams {
  scriptId: string;
  path?: string;
  type?: 'SERVER_JS' | 'HTML' | 'JSON';
}

export interface LsToolResult {
  success: boolean;
  scriptId?: string;
  files?: Array<{
    name: string;
    type: 'SERVER_JS' | 'HTML' | 'JSON';
    position?: number;
    createTime?: string;
    updateTime?: string;
    lastModifyUser?: { name?: string; email?: string };
    size?: number;
    functionSet?: { values: Array<{ name: string }> };
  }>;
  count?: number;
  error?: string;
  hints: Record<string, string>;
}

export const LS_TOOL_DEFINITION = {
  name: 'ls',
  description: `List files in a Google Apps Script project (metadata only — no source content).

Returns file names, types, sizes, positions, timestamps, and function signatures. Source code is omitted to keep responses small — use pull to download files locally.

Optional filters:
- path: filter files by name. Plain substring match by default; treated as regex if the value contains regex metacharacters (^$.*+?()[]{}|\\). Max 200 characters.
- type: filter by file type (SERVER_JS, HTML, or JSON).

Files are sorted by position (GAS execution order), which matters for CommonJS module loading.`,
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'Google Apps Script project ID',
      },
      path: {
        type: 'string',
        description: 'Filter files by name — substring match or regex (e.g. "utils", "^common-js/", ".*test.*")',
      },
      type: {
        type: 'string',
        enum: ['SERVER_JS', 'HTML', 'JSON'],
        description: 'Filter by file type',
      },
    },
    required: ['scriptId'],
  },
};

// Regex metacharacters — if path contains any of these, treat it as a regex pattern.
const REGEX_META = /[\\^$.*+?()[\]{}|]/;

// Cap path length to mitigate ReDoS on user-supplied patterns.
// GAS file names are short, so this is a defensive ceiling rather than a practical limit.
const MAX_PATH_LENGTH = 200;

/**
 * List files in a GAS project with optional path/type filtering.
 * Strips source content and returns metadata + size (source byte count).
 */
export async function handleLsTool(
  params: LsToolParams,
  fileOps: GASFileOperations,
): Promise<LsToolResult> {
  const { scriptId, path, type } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      error: 'Invalid scriptId — must be 20+ alphanumeric characters, hyphens, or underscores.',
      hints: { fix: 'Check the scriptId and try again. Use projects tool to find valid IDs.' },
    };
  }

  // Validate path length before attempting regex compilation (ReDoS defense).
  if (path && path.length > MAX_PATH_LENGTH) {
    return {
      success: false,
      error: `path filter too long (${path.length} chars, max ${MAX_PATH_LENGTH}). Use a shorter pattern.`,
      hints: { fix: 'Shorten the path filter or use a simpler substring match.' },
    };
  }

  // Build path matcher: regex if metacharacters detected, otherwise case-insensitive substring.
  let pathMatcher: ((name: string) => boolean) | undefined;
  if (path) {
    if (REGEX_META.test(path)) {
      try {
        const re = new RegExp(path, 'i');
        pathMatcher = (name: string) => re.test(name);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          error: `Invalid regex in path filter: ${message}`,
          hints: { fix: 'Fix the regex syntax or use a plain substring (no special characters).' },
        };
      }
    } else {
      const lower = path.toLowerCase();
      pathMatcher = (name: string) => name.toLowerCase().includes(lower);
    }
  }

  try {
    const allFiles = await fileOps.getProjectFiles(scriptId);

    let files = allFiles;

    if (pathMatcher) {
      files = files.filter((f) => pathMatcher!(f.name));
    }

    if (type) {
      files = files.filter((f) => f.type === type);
    }

    // Sort by position — GAS execution order matters for CommonJS module loading.
    // Files without a position sort last.
    files.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

    const mapped = files.map((f) => ({
      name: f.name,
      type: f.type,
      position: f.position,
      createTime: f.createTime,
      updateTime: f.updateTime,
      lastModifyUser: f.lastModifyUser,
      size: f.source?.length,
      functionSet: f.functionSet,
    }));

    return {
      success: true,
      scriptId,
      files: mapped,
      count: mapped.length,
      hints: {
        next: mapped.length > 0
          ? `Found ${mapped.length} file(s). Use pull to download files locally, or push to sync changes back.`
          : 'No files found. The project may be empty or all files were filtered out.',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isAuth = message.includes('401') || message.includes('403') || message.includes('auth') || message.includes('token');
    return {
      success: false,
      error: message,
      hints: {
        fix: isAuth
          ? 'Authentication issue — re-authenticate with auth action="login"'
          : 'Check the scriptId and try again',
      },
    };
  }
}
