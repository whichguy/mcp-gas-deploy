/**
 * Project Copy Tool for mcp-gas-deploy
 *
 * Creates a new standalone GAS project as a copy of an existing project.
 * Copies all source files to the new project atomically.
 *
 * What IS copied:
 *   - All .gs, .html, and .json files from the source project
 *
 * What is NOT copied automatically:
 *   - Script properties (set via PropertiesService) — must be copied manually
 *     or via exec after the copy is created
 *   - Container-bound spreadsheet data — the copy is always a standalone script;
 *     if the source was container-bound, the parent Sheet/Doc is NOT copied
 *   - Trigger registrations — triggers must be re-created in the new project
 *
 * No state is tracked (no gas-deploy.json updates). Run deploy on the new
 * scriptId separately to create a web app deployment.
 */

import { GASFileOperations } from '../api/gasFileOperations.js';
import { GASProjectOperations } from '../api/gasProjectOperations.js';
import { SCRIPT_ID_PATTERN } from '../utils/validation.js';
import { orderFilesForPush } from '../sync/rsync.js';

export interface ProjectCopyToolParams {
  scriptId: string;
  title?: string;
}

export interface ProjectCopyToolResult {
  success: boolean;
  newScriptId?: string;
  title?: string;
  filesCopied?: number;
  sourceScriptId?: string;
  warnings?: string[];
  error?: string;
  hints: Record<string, string>;
}

export const PROJECT_COPY_TOOL_DEFINITION = {
  name: 'project_copy',
  description: `Copy an existing GAS project to a new standalone project.

Copies all files (.gs, .html, .json) from the source project to a newly created project.
The new project is always standalone — if the source was container-bound (bound to a Sheet
or Doc), the parent document is NOT copied.

NOT copied automatically:
  - Script properties (PropertiesService) — copy manually after creation
  - Trigger registrations — re-create manually or via exec in the new project
  - Container parent (Sheets/Docs data) — create a new spreadsheet separately

After copy, use push/exec/deploy with the returned newScriptId to work with the new project.`,
  annotations: { destructiveHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'Source GAS project scriptId to copy from',
      },
      title: {
        type: 'string',
        description: 'Title for the new project (default: "Copy of <source title>")',
      },
    },
    required: ['scriptId'],
  },
};

export async function handleProjectCopyTool(
  params: ProjectCopyToolParams,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations
): Promise<ProjectCopyToolResult> {
  const { scriptId, title } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  let newProject: { scriptId: string; title: string } | undefined;
  try {
    // Resolve the title for the new project
    const sourceTitle = await projectOps.getProjectTitle(scriptId);
    const newTitle = title ?? (sourceTitle ? `Copy of ${sourceTitle}` : `Copy of ${scriptId}`);

    // Fetch all files from the source project
    const sourceFiles = await fileOps.getProjectFiles(scriptId);

    if (sourceFiles.length === 0) {
      return {
        success: false,
        error: 'Source project has no files to copy',
        hints: { fix: 'Verify the scriptId is correct and you have access to the project' },
      };
    }

    // Create the new project
    newProject = await projectOps.createProject(newTitle);

    // Upload all source files to the new project atomically, preserving source project order
    const filesToCopy = sourceFiles.map(f => ({ name: f.name, type: f.type, source: f.source ?? '' }));
    const orderedFiles = orderFilesForPush(filesToCopy, sourceFiles);
    await fileOps.updateProjectFiles(newProject.scriptId, orderedFiles);

    const warnings: string[] = [
      'Script properties (PropertiesService) are NOT copied — set them manually in the new project',
      'Trigger registrations are NOT copied — re-create them manually or via exec',
      'If the source was container-bound, the parent document (Sheet/Doc) is NOT copied — create a new spreadsheet and link it separately',
    ];

    return {
      success: true,
      newScriptId: newProject.scriptId,
      title: newProject.title,
      filesCopied: sourceFiles.length,
      sourceScriptId: scriptId,
      warnings,
      hints: {
        next: `New project created (${newProject.scriptId}). Use pull, push, exec, or deploy with newScriptId to work with the copy.`,
        properties: 'To copy script properties: exec a function in the source that returns PropertiesService.getScriptProperties().getProperties(), then set them in the copy.',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const orphanNote = newProject
      ? ` An empty project was created (${newProject.scriptId}) and must be deleted manually via the Apps Script console.`
      : '';
    return {
      success: false,
      error: `Project copy failed: ${message}${orphanNote}`,
      hints: {
        fix: 'Check authentication and that you have access to both the source project and permission to create new projects',
        ...(newProject ? { orphan: `Delete the empty project at https://script.google.com/home/projects/${newProject.scriptId}/edit` } : {}),
      },
    };
  }
}
