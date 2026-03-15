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
import { SchemaFragments } from '../utils/schemaFragments.js';
import { GuidanceFragments } from '../utils/guidanceFragments.js';

export interface ProjectCopyToolParams {
  scriptId: string;
  title?: string;
  destinationScriptId?: string;
}

export interface ProjectCopyToolResult {
  success: boolean;
  /** @deprecated Use targetScriptId instead. Kept for backward compatibility. */
  newScriptId?: string;
  /** The scriptId of the target project (new or existing). Always set on success. */
  targetScriptId?: string;
  /** 'created' when a new project was made, 'overwritten' when destinationScriptId was used. */
  mode?: 'created' | 'overwritten';
  title?: string;
  filesCopied?: number;
  sourceScriptId?: string;
  warnings?: string[];
  error?: string;
  hints: Record<string, string>;
}

export const PROJECT_COPY_TOOL_DEFINITION = {
  name: 'project_copy',
  description: '[PROJECT:COPY] Copy a GAS project\'s files to a new or existing project — preserves file order and appsscript.json. WHEN: cloning a template, forking, copying into container-bound project. AVOID: properties/triggers NOT copied (use the exec workflow in llmGuidance). Example: project_copy({scriptId: "source123", title: "My Fork"})',
  annotations: {
    title: 'Copy GAS Project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...SchemaFragments.scriptId,
      title: {
        type: 'string',
        description: 'Title for the new project (default: "Copy of <source title>")',
      },
      destinationScriptId: {
        type: 'string',
        description: 'Existing GAS project to copy files INTO (overwrites all files). If omitted, a new project is created.',
      },
    },
    required: ['scriptId'],
    additionalProperties: false,
    llmGuidance: {
      propertiesCopy: GuidanceFragments.propertiesCopyWorkflow,
      triggerCopy: 'Triggers are NOT copied. Re-create them in the new project via the trigger tool.',
      containerBound: 'If the source was container-bound (Sheets/Docs), the copy is standalone. Create a new spreadsheet and link it separately.',
      destinationMode: 'If destinationScriptId is provided, files are copied INTO the existing project (all files overwritten). Script properties in the destination are preserved (only files change). If copy fails, destination is unchanged — re-run to retry.',
      errorRecovery: GuidanceFragments.errorRecovery,
    },
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      newScriptId: { type: 'string', description: 'Deprecated — use targetScriptId' },
      targetScriptId: { type: 'string' },
      mode: { type: 'string', enum: ['created', 'overwritten'] },
      title: { type: 'string' },
      filesCopied: { type: 'number' },
      sourceScriptId: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
      hints: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['success'],
  },
};

export async function handleProjectCopyTool(
  params: ProjectCopyToolParams,
  fileOps: GASFileOperations,
  projectOps: GASProjectOperations
): Promise<ProjectCopyToolResult> {
  const { scriptId, title, destinationScriptId } = params;

  if (!SCRIPT_ID_PATTERN.test(scriptId)) {
    return {
      success: false,
      error: 'Invalid scriptId format',
      hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  // Self-copy prevention
  if (destinationScriptId && destinationScriptId === scriptId) {
    return {
      success: false,
      error: 'Source and destination scriptIds are the same — cannot copy a project into itself',
      hints: { fix: 'Provide a different destinationScriptId or omit it to create a new project' },
    };
  }

  // Validate destinationScriptId format
  if (destinationScriptId && !SCRIPT_ID_PATTERN.test(destinationScriptId)) {
    return {
      success: false,
      error: 'Invalid destinationScriptId format',
      hints: { fix: 'destinationScriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
    };
  }

  let newProject: { scriptId: string; title: string } | undefined;
  try {
    // Fetch all files from the source project
    const sourceFiles = await fileOps.getProjectFiles(scriptId);

    if (sourceFiles.length === 0) {
      return {
        success: false,
        error: 'Source project has no files to copy',
        hints: { fix: 'Verify the scriptId is correct and you have access to the project' },
      };
    }

    // Determine target project
    let targetScriptId: string;
    let targetTitle: string;
    let mode: 'created' | 'overwritten';

    if (destinationScriptId) {
      // Copy into existing project — verify it exists
      const destTitle = await projectOps.getProjectTitle(destinationScriptId);
      if (destTitle === null) {
        return {
          success: false,
          error: `Destination project not found: ${destinationScriptId}`,
          hints: { fix: 'Verify the destinationScriptId is correct and you have edit access to the project. Use projects tool to find valid IDs.' },
        };
      }
      targetScriptId = destinationScriptId;
      targetTitle = destTitle;
      mode = 'overwritten';
    } else {
      // Create new project
      const sourceTitle = await projectOps.getProjectTitle(scriptId);
      const newTitle = title ?? (sourceTitle ? `Copy of ${sourceTitle}` : `Copy of ${scriptId}`);
      newProject = await projectOps.createProject(newTitle);
      targetScriptId = newProject.scriptId;
      targetTitle = newProject.title;
      mode = 'created';
    }

    // Upload all source files to the target project atomically, preserving source project order
    const filesToCopy = sourceFiles.map(f => ({ name: f.name, type: f.type, source: f.source ?? '' }));
    const orderedFiles = orderFilesForPush(filesToCopy, sourceFiles);
    await fileOps.updateProjectFiles(targetScriptId, orderedFiles);

    const warnings: string[] = [
      'Script properties (PropertiesService) are NOT copied — set them manually in the target project',
      'Trigger registrations are NOT copied — re-create them manually or via exec',
    ];
    if (!destinationScriptId) {
      warnings.push('If the source was container-bound, the parent document (Sheet/Doc) is NOT copied — create a new spreadsheet and link it separately');
    }
    if (destinationScriptId) {
      warnings.push('All existing files in the destination project were overwritten');
      warnings.push('Script properties in the destination project are preserved (only files were replaced)');
    }

    return {
      success: true,
      newScriptId: targetScriptId,
      targetScriptId,
      mode,
      title: targetTitle,
      filesCopied: sourceFiles.length,
      sourceScriptId: scriptId,
      warnings,
      hints: {
        next: mode === 'created'
          ? `New project created (${targetScriptId}). Use pull, push, exec, or deploy with targetScriptId to work with the copy.`
          : `Files copied into existing project (${targetScriptId}). Use push, exec, or deploy to continue.`,
        properties: 'To copy script properties: exec a function in the source that returns PropertiesService.getScriptProperties().getProperties(), then set them in the target.',
        ...(mode === 'overwritten' ? { retry: 'If copy fails, destination is unchanged — re-run project_copy to retry.' } : {}),
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
        ...(newProject ? { orphan: `Delete the empty project at https://script.google.com/projects/${newProject.scriptId}/edit` } : {}),
      },
    };
  }
}
