/**
 * Projects Tool for mcp-gas-deploy
 *
 * Discovers standalone Google Apps Script projects via the Drive API.
 * Returns scriptIds and names so LLMs/users can find projects without
 * knowing the scriptId upfront.
 *
 * Limitation: only standalone scripts are discoverable. Container-bound
 * scripts (attached to Docs/Sheets/Slides) are not separate Drive files
 * and cannot be found here — use the known scriptId directly with other tools.
 *
 * Requires drive.readonly scope — re-authenticate if this tool returns a scope error.
 */

import { GASProjectOperations } from '../api/gasProjectOperations.js';

export interface ProjectsToolParams {
  action: 'list' | 'search';
  query?: string;
}

export interface ProjectsToolResult {
  success: boolean;
  projects?: Array<{
    scriptId: string;
    title: string;
    createTime?: string;
    updateTime?: string;
  }>;
  count?: number;
  error?: string;
  hints: Record<string, string>;
}

export const PROJECTS_TOOL_DEFINITION = {
  name: 'projects',
  description: `Discover standalone Google Apps Script projects. Returns scriptIds and names.

action=list: list all GAS projects visible to the authenticated user (up to 100, most recently modified first).
action=search: filter by name substring (requires query parameter).

LIMITATION: Only standalone scripts are returned. Container-bound scripts (bound to a Sheet, Doc, or Slide) are not discoverable via this tool — use the known scriptId directly.

Requires drive.readonly OAuth scope. If you see a scope error, re-authenticate with auth action=login.`,
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search'],
        description: 'list: show all projects | search: filter by name (requires query)',
      },
      query: {
        type: 'string',
        description: 'Name substring to filter by (required for search action)',
      },
    },
    required: ['action'],
  },
};

export async function handleProjectsTool(
  params: ProjectsToolParams,
  projectOps: GASProjectOperations
): Promise<ProjectsToolResult> {
  const { action, query } = params;

  if (action === 'search' && !query) {
    return {
      success: false,
      error: 'query is required for search action',
      hints: { fix: 'Provide a name filter with the query parameter' },
    };
  }

  try {
    const nameFilter = action === 'search' ? query : undefined;
    const projects = await projectOps.listProjects(nameFilter);

    return {
      success: true,
      projects: projects.map(p => ({
        scriptId: p.scriptId,
        title: p.title,
        createTime: p.createTime,
        updateTime: p.updateTime,
      })),
      count: projects.length,
      hints: {
        next: projects.length > 0
          ? `Found ${projects.length} project(s). Use scriptId with push, exec, pull, or deploy.`
          : 'No projects found. Container-bound scripts are not listed here — use the scriptId directly.',
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isDriveScope = message.includes('scope') || message.includes('403') || message.includes('drive');
    return {
      success: false,
      error: message,
      hints: {
        fix: isDriveScope
          ? 'Re-authenticate to grant drive.readonly scope: run auth with action="login"'
          : 'Check authentication and try again',
      },
    };
  }
}
