/**
 * Create Tool for mcp-gas-deploy
 *
 * Creates a new GAS project remotely and bootstraps the local directory
 * with manifest, runtime files, .clasp.json, .gitignore, push, and git init.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GASProjectOperations } from '../api/gasProjectOperations.js';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { push, ensureClaspFiles } from '../sync/rsync.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_DIR = path.join(__dirname, '..', '..', 'runtime');

const RUNTIME_FILES = [
  { src: 'require.gs',              dest: 'require.gs' },
  { src: 'ConfigManager.gs',        dest: 'common-js/ConfigManager.gs' },
  { src: '__mcp_exec.gs',           dest: 'common-js/__mcp_exec.gs' },
  { src: 'html_utils.gs',           dest: 'common-js/html_utils.gs' },
  { src: '__mcp_exec_success.html', dest: 'common-js/__mcp_exec_success.html' },
  { src: '__mcp_exec_error.html',   dest: 'common-js/__mcp_exec_error.html' },
];

const DEFAULT_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.external_request',
];

export interface CreateToolParams {
  title: string;
  localDir?: string;
  parentId?: string;
  oauthScopes?: string[];
  webapp?: {
    executeAs?: string;
    access?: string;
  };
}

export interface CreateToolResult {
  success: boolean;
  scriptId?: string;
  title?: string;
  localDir?: string;
  runtimeIncluded?: boolean;
  filesPushed?: string[];
  error?: string;
  hints: Record<string, string>;
}

export const CREATE_TOOL_DEFINITION = {
  name: 'create',
  description: '[PROJECT:CREATE] Create a new GAS project with runtime files (exec-ready). WHEN: starting a new project from scratch. Example: create({title: "My Project"})',
  annotations: {
    title: 'Create GAS Project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'Title for the new GAS project',
      },
      localDir: {
        type: 'string',
        description: 'Local directory to bootstrap (default: current working directory)',
      },
      parentId: {
        type: 'string',
        description: 'Google Drive folder ID to create the project in',
      },
      oauthScopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional OAuth scopes beyond exec defaults (script.scriptapp, script.external_request)',
      },
      webapp: {
        type: 'object',
        properties: {
          executeAs: {
            type: 'string',
            description: 'Who the script runs as: USER_DEPLOYING (default) or USER_ACCESSING',
          },
          access: {
            type: 'string',
            description: 'Who can access: MYSELF (default), DOMAIN, or ANYONE',
          },
        },
        additionalProperties: false,
        description: 'Web app configuration overrides',
      },
    },
    required: ['title'],
    additionalProperties: false,
    llmGuidance: {
      workflow: GuidanceFragments.createWorkflow,
      next: 'After create, run deploy (staging) → visit HEAD URL for browser auth → exec.',
      resolution: GuidanceFragments.claspResolution,
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      scriptId: { type: 'string' },
      title: { type: 'string' },
      localDir: { type: 'string' },
      runtimeIncluded: { type: 'boolean' },
      filesPushed: {
        type: 'array',
        items: { type: 'string' },
      },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success'],
  },
};

export { RUNTIME_DIR, RUNTIME_FILES };

async function verifyRuntimeFiles(): Promise<string | null> {
  try {
    await fs.access(RUNTIME_DIR);
  } catch {
    return `Runtime directory not found at ${RUNTIME_DIR}. Run npm run sync-runtime to populate runtime files.`;
  }
  for (const file of RUNTIME_FILES) {
    try {
      await fs.access(path.join(RUNTIME_DIR, file.src));
    } catch {
      return `Runtime file missing: ${file.src}. Run npm run sync-runtime to populate runtime files.`;
    }
  }
  return null;
}

export type PushFn = typeof push;

export async function handleCreateTool(
  params: CreateToolParams,
  projectOps: GASProjectOperations,
  fileOps: GASFileOperations,
  pushFn: PushFn = push
): Promise<CreateToolResult> {
  const { title, parentId } = params;

  if (!title || title.trim().length === 0) {
    return {
      success: false,
      error: 'title is required',
      hints: { fix: 'Provide a non-empty title for the new GAS project.' },
    };
  }

  // Verify bundled runtime files exist
  const runtimeError = await verifyRuntimeFiles();
  if (runtimeError) {
    return {
      success: false,
      error: runtimeError,
      hints: { fix: 'Run npm run sync-runtime to populate runtime files.' },
    };
  }

  // Resolve and validate localDir
  let localDir: string;
  if (params.localDir) {
    localDir = params.localDir.startsWith('~')
      ? path.join(os.homedir(), params.localDir.slice(1))
      : path.resolve(params.localDir);
  } else {
    localDir = process.cwd();
  }

  // Path traversal guard
  const homedir = os.homedir();
  if (!localDir.startsWith(homedir + path.sep) && localDir !== homedir) {
    return {
      success: false,
      error: `localDir must resolve within your home directory. Got: ${localDir}`,
      hints: { fix: 'Use an absolute path within ~/ or omit localDir to use CWD.' },
    };
  }

  // Step 1: Create remote project
  let scriptId: string;
  let projectTitle: string;
  try {
    const project = await projectOps.createProject(title, parentId);
    scriptId = project.scriptId;
    projectTitle = project.title;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to create remote project: ${message}`,
      hints: { fix: 'Check authentication (run auth action="login") and try again.' },
    };
  }

  // From this point on, include scriptId in error responses for recovery
  try {
    // Step 2: Create local directory if needed
    await fs.mkdir(localDir, { recursive: true });

    // Step 3: Create common-js/ subdirectory and copy runtime files
    await fs.mkdir(path.join(localDir, 'common-js'), { recursive: true });
    for (const file of RUNTIME_FILES) {
      await fs.copyFile(
        path.join(RUNTIME_DIR, file.src),
        path.join(localDir, file.dest)
      );
    }

    // Step 4: Build and write manifest
    const baseScopes = [...DEFAULT_OAUTH_SCOPES];
    if (params.oauthScopes) {
      for (const scope of params.oauthScopes) {
        if (!baseScopes.includes(scope)) {
          baseScopes.push(scope);
        }
      }
    }

    const manifest = {
      timeZone: 'America/New_York',
      exceptionLogging: 'STACKDRIVER',
      runtimeVersion: 'V8',
      webapp: {
        executeAs: params.webapp?.executeAs ?? 'USER_DEPLOYING',
        access: params.webapp?.access ?? 'MYSELF',
      },
      oauthScopes: baseScopes,
    };
    const manifestPath = path.join(localDir, 'appsscript.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    // Step 5: Write .clasp.json and ensure .gitignore
    await ensureClaspFiles(localDir, scriptId, true);

    // Step 6: Push all files to GAS (ordering handled by push)
    const pushResult = await pushFn(scriptId, localDir, fileOps, { prune: true });
    if (!pushResult.success) {
      return {
        success: false,
        scriptId,
        title: projectTitle,
        localDir,
        error: `Project created but push failed: ${pushResult.error ?? 'unknown error'}`,
        hints: {
          recovery: `Project was created remotely. Run pull({scriptId: "${scriptId}", localDir: "${localDir}"}) to complete setup.`,
          fix: pushResult.validationErrors?.length
            ? 'Fix validation errors and run push manually.'
            : 'Check authentication and try push manually.',
        },
      };
    }

    // Step 7: Git init + initial commit (best-effort, non-fatal)
    try {
      await fs.access(path.join(localDir, '.git'));
      // Already a git repo — skip init
    } catch {
      try {
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: localDir, timeout: 10000 });
        await execFileAsync(
          'git',
          ['add', '--', 'appsscript.json', '.clasp.json', '.gitignore', 'require.gs', 'common-js/'],
          { cwd: localDir, timeout: 10000 }
        );
        await execFileAsync(
          'git',
          ['commit', '-m', `Initial create: ${title}`],
          { cwd: localDir, timeout: 10000 }
        );
      } catch {
        // git not available or init failed — non-fatal
      }
    }

    return {
      success: true,
      scriptId,
      title: projectTitle,
      localDir,
      runtimeIncluded: true,
      filesPushed: pushResult.filesPushed,
      hints: {
        next: 'Run deploy to create a staging deployment, then visit HEAD URL in Chrome for browser auth, then exec.',
        commonjs: GuidanceFragments.commonJsPattern,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      scriptId,
      title: projectTitle,
      localDir,
      error: `Project created (scriptId: ${scriptId}) but local setup failed: ${message}`,
      hints: {
        recovery: `Project was created remotely. Run pull({scriptId: "${scriptId}", localDir: "${localDir}"}) to complete setup.`,
        fix: 'Check filesystem permissions and try again.',
      },
    };
  }
}
