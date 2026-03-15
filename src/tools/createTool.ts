/**
 * Create Tool for mcp-gas-deploy
 *
 * Creates a new GAS project remotely and bootstraps the local directory
 * with appsscript.json, .clasp.json, .gitignore, and git init.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GASProjectOperations } from '../api/gasProjectOperations.js';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { ensureClaspFiles } from '../sync/rsync.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

const execFileAsync = promisify(execFile);

export interface CreateToolParams {
  title: string;
  localDir?: string;
  parentId?: string;
}

export interface CreateToolResult {
  success: boolean;
  scriptId?: string;
  title?: string;
  localDir?: string;
  error?: string;
  hints: Record<string, string>;
}

export const CREATE_TOOL_DEFINITION = {
  name: 'create',
  description: '[PROJECT:CREATE] Create a new GAS project and bootstrap local directory with manifest, .clasp.json, and git. WHEN: starting a new project from scratch. Example: create({title: "My Project"})',
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
    },
    required: ['title'],
    additionalProperties: false,
    llmGuidance: {
      workflow: 'create bootstraps: remote project + local dir + appsscript.json + .clasp.json + git init.',
      next: 'After create, edit files locally then use push to upload changes.',
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
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success'],
  },
};

export async function handleCreateTool(
  params: CreateToolParams,
  projectOps: GASProjectOperations,
  fileOps: GASFileOperations
): Promise<CreateToolResult> {
  const { title, parentId } = params;

  if (!title || title.trim().length === 0) {
    return {
      success: false,
      error: 'title is required',
      hints: { fix: 'Provide a non-empty title for the new GAS project.' },
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

    // Step 3: Write default appsscript.json
    const manifest = {
      timeZone: 'America/New_York',
      exceptionLogging: 'STACKDRIVER',
      runtimeVersion: 'V8',
    };
    const manifestPath = path.join(localDir, 'appsscript.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    // Step 4: Write .clasp.json and ensure .gitignore
    // Always write (reparent=true) since create just made a new project
    await ensureClaspFiles(localDir, scriptId, true);

    // Step 5: Push appsscript.json to GAS (so remote project isn't empty)
    await fileOps.updateProjectFiles(scriptId, [
      { name: 'appsscript', type: 'JSON', source: JSON.stringify(manifest, null, 2) + '\n' },
    ]);

    // Step 6: Git init + initial commit (best-effort, non-fatal)
    try {
      await fs.access(path.join(localDir, '.git'));
      // Already a git repo — skip init
    } catch {
      try {
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: localDir, timeout: 10000 });
        await execFileAsync(
          'git',
          ['add', '--', 'appsscript.json', '.clasp.json', '.gitignore'],
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
      hints: {
        next: 'Edit files locally, then run push to upload or exec to test.',
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
