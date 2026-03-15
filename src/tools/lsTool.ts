/**
 * Ls Tool for mcp-gas-deploy
 *
 * Lists files in a Google Apps Script project (metadata only — no source).
 * Supports optional filtering by file name (substring or regex) and file type.
 * Returns files sorted by GAS execution position.
 */

import type { GASFileOperations } from '../api/gasFileOperations.js';
import { resolveProject } from '../utils/resolveProject.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

export interface LsToolParams {
  scriptId?: string;
  localDir?: string;
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
  description: '[PROJECT:READ] List GAS project files (metadata only, no source). WHEN: exploring project structure or checking file order. AVOID: use pull to download source. Example: ls({scriptId: "1abc..."})',
  annotations: {
    title: 'List Project Files',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      ...SchemaFragments.localDir,
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
    required: [],
    additionalProperties: false,
    llmGuidance: {
      resolution: GuidanceFragments.claspResolution,
      positionMatters: 'Files are sorted by GAS execution position — this determines CommonJS module load order. require.gs must be position 0.',
      typeFilter: 'SERVER_JS = .gs files, HTML = .html templates, JSON = appsscript.json manifest.',
      pathFilter: 'Plain substring by default; auto-detects regex metacharacters (^$.*+?). Max 200 chars.',
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      scriptId: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            position: { type: 'number' },
            size: { type: 'number' },
            functionSet: { type: 'object' },
          },
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success'],
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
  const { path, type } = params;

  let resolved;
  try {
    resolved = await resolveProject({ scriptId: params.scriptId, localDir: params.localDir });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      hints: { fix: 'Provide scriptId explicitly, or point localDir to a directory with .clasp.json.' },
    };
  }

  const { scriptId } = resolved;

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

    const hints: Record<string, string> = {};
    if (resolved.resolvedFrom === 'clasp-json') {
      hints.scriptId = `Using scriptId ${scriptId} from .clasp.json`;
    }
    hints.next = mapped.length > 0
      ? `Found ${mapped.length} file(s). Use pull to download files locally, or push to sync changes back.`
      : 'No files found. The project may be empty or all files were filtered out.';

    return {
      success: true,
      scriptId,
      files: mapped,
      count: mapped.length,
      hints,
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
