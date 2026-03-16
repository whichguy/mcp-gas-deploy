/**
 * Fork Tool for mcp-gas-deploy
 *
 * Creates a branch-specific isolated GAS project by:
 *   1. Copying the source project to a new remote project
 *   2. Pushing local files to the fork
 *   3. Switching the fork's GCP project (enabling scripts.run)
 *   4. Mapping the fork in .clasp.json for branch-based resolution
 *
 * Partial failure recovery: if copy succeeds but GCP switch fails,
 * the fork is still usable via web app (web-app-fallback mode).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GASProjectOperations } from '../api/gasProjectOperations.js';
import { GASFileOperations } from '../api/gasFileOperations.js';
import { push } from '../sync/rsync.js';
import { resolveProject } from '../utils/resolveProject.js';
import { setDeploymentInfo, readDeployConfig, getDeploymentInfo } from '../config/deployConfig.js';
import { switchGcpProject, type ChromeDevtools } from '../utils/gcpSwitch.js';
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';
import { getCurrentBranch } from '../utils/gitBranch.js';

export interface ForkToolParams {
  scriptId?: string;
  localDir?: string;
  branch?: string;
  gcpProjectNumber?: string;
  title?: string;
}

export interface ForkToolResult {
  success: boolean;
  forkScriptId?: string;
  sourceScriptId?: string;
  branch?: string;
  execMode?: 'scripts-run' | 'web-app-fallback';
  localDir?: string;
  error?: string;
  hints: Record<string, string>;
}

export const FORK_TOOL_DEFINITION = {
  name: 'fork',
  description: '[PROJECT:FORK] Create an isolated GAS project fork for parallel development. Copies source → pushes local files → switches GCP project → enables scripts.run exec. WHEN: worktree/branch isolation, parallel subagents, avoiding push collisions.',
  annotations: {
    title: 'Fork GAS Project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      ...SchemaFragments.localDir,
      branch: {
        type: 'string',
        description: 'Git branch name for this fork. Auto-detected from localDir if omitted.',
      },
      gcpProjectNumber: {
        type: 'string',
        description: 'Standard GCP project number for scripts.run (e.g. "428972970708"). Falls back to gas-deploy.json gcpProjectNumber.',
      },
      title: {
        type: 'string',
        description: 'Title for the forked project. Defaults to "Fork: <branch>".',
      },
    },
    required: [] as string[],
    additionalProperties: false,
    llmGuidance: {
      workflow: GuidanceFragments.forkWorkflow,
      resolution: GuidanceFragments.claspResolution,
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      forkScriptId: { type: 'string' },
      sourceScriptId: { type: 'string' },
      branch: { type: 'string' },
      execMode: { type: 'string' },
      localDir: { type: 'string' },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success'],
  },
};

export async function handleForkTool(
  params: ForkToolParams,
  projectOps: GASProjectOperations,
  fileOps: GASFileOperations,
  chromeDevtools?: ChromeDevtools
): Promise<ForkToolResult> {
  // Step 1: Resolve source project
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

  const { scriptId: sourceScriptId, localDir: resolvedDir } = resolved;

  // Step 2: Detect branch
  let branch = params.branch;
  if (!branch) {
    try {
      const branchInfo = await getCurrentBranch(resolvedDir);
      branch = branchInfo.branch;
    } catch {
      branch = 'fork';
    }
  }

  // Step 3: Check for existing fork in .clasp.json
  try {
    const claspPath = path.join(resolvedDir, '.clasp.json');
    const claspContent = await fs.readFile(claspPath, 'utf-8');
    const clasp = JSON.parse(claspContent);
    if (clasp.branches?.[branch]) {
      const existingForkId = clasp.branches[branch] as string;
      // Check gas-deploy.json to determine the actual execMode of the existing fork
      let existingExecMode: 'scripts-run' | 'web-app-fallback' = 'web-app-fallback';
      try {
        const existingInfo = await getDeploymentInfo(resolvedDir, existingForkId);
        if ((existingInfo as Record<string, unknown>).gcpSwitched) {
          existingExecMode = 'scripts-run';
        }
      } catch {
        // No config — default to web-app-fallback (safe)
      }
      return {
        success: true,
        forkScriptId: existingForkId,
        sourceScriptId,
        branch,
        execMode: existingExecMode,
        localDir: resolvedDir,
        hints: { existing: `Fork already exists for branch "${branch}". Using existing fork.` },
      };
    }
  } catch {
    // No .clasp.json or no branches — continue with fork creation
  }

  // Step 4: Resolve GCP project number
  let gcpProjectNumber = params.gcpProjectNumber;
  if (!gcpProjectNumber) {
    try {
      const config = await readDeployConfig(resolvedDir);
      const rootConfig = config as Record<string, unknown>;
      gcpProjectNumber = rootConfig.gcpProjectNumber as string | undefined;
    } catch {
      // No config — continue without
    }
  }

  // Step 5: Create remote fork project
  const forkTitle = params.title ?? `Fork: ${branch}`;
  let forkScriptId: string;
  try {
    const project = await projectOps.createProject(forkTitle);
    forkScriptId = project.scriptId;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sourceScriptId,
      branch,
      error: `Failed to create fork project: ${message}`,
      hints: { fix: 'Check authentication (run auth action="login") and try again.' },
    };
  }

  // Step 6: Push local files to the fork
  try {
    const pushResult = await push(forkScriptId, resolvedDir, fileOps, { prune: true });
    if (!pushResult.success) {
      return {
        success: false,
        forkScriptId,
        sourceScriptId,
        branch,
        localDir: resolvedDir,
        error: `Fork created but push failed: ${pushResult.error}`,
        hints: {
          recovery: `Fork project created (scriptId: ${forkScriptId}). Fix push errors and retry with push({scriptId: "${forkScriptId}", localDir: "${resolvedDir}"}).`,
        },
      };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      forkScriptId,
      sourceScriptId,
      branch,
      localDir: resolvedDir,
      error: `Fork created but push failed: ${message}`,
      hints: {
        recovery: `Fork project created (scriptId: ${forkScriptId}). Retry push manually.`,
      },
    };
  }

  // Step 7: Switch GCP project (if chrome-devtools available and gcpProjectNumber known)
  let execMode: 'scripts-run' | 'web-app-fallback' = 'web-app-fallback';
  if (chromeDevtools && gcpProjectNumber) {
    try {
      const switchResult = await switchGcpProject(forkScriptId, gcpProjectNumber, chromeDevtools);
      if (switchResult.success) {
        execMode = 'scripts-run';
      }
      // GCP switch failure is non-fatal — fork still works via web app
    } catch {
      // Non-fatal
    }
  }

  // Step 8: Update .clasp.json with branch mapping
  try {
    const claspPath = path.join(resolvedDir, '.clasp.json');
    let clasp: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(claspPath, 'utf-8');
      clasp = JSON.parse(content);
    } catch {
      // New .clasp.json
    }

    if (!clasp.branches) clasp.branches = {};
    (clasp.branches as Record<string, string>)[branch] = forkScriptId;
    await fs.writeFile(claspPath, JSON.stringify(clasp, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — fork works without branch mapping
  }

  // Step 9: Write gas-deploy.json for the fork
  try {
    if (execMode === 'scripts-run') {
      // Store gcpSwitched flag for exec tool routing
      await setDeploymentInfo(resolvedDir, forkScriptId, { gcpSwitched: true } as Record<string, unknown>);
    }
  } catch {
    // Non-fatal
  }

  const hints: Record<string, string> = {
    next: execMode === 'scripts-run'
      ? `Fork ready with scripts.run (no browser auth needed). Run exec({scriptId: "${forkScriptId}"}) to execute.`
      : `Fork ready in web-app-fallback mode. Deploy and authorize in browser before exec. To enable scripts.run: provide gcpProjectNumber and ensure chrome-devtools MCP is running.`,
  };

  if (execMode === 'web-app-fallback' && !gcpProjectNumber) {
    hints.gcpProjectNumber = 'Set gcpProjectNumber in gas-deploy.json or pass it explicitly. Find your Standard GCP project number at console.cloud.google.com > project settings.';
  }

  return {
    success: true,
    forkScriptId,
    sourceScriptId,
    branch,
    execMode,
    localDir: resolvedDir,
    hints,
  };
}
