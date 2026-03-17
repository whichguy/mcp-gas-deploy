/**
 * Project Operations for mcp_gas_deploy
 *
 * Provides project discovery (Drive API) and project management (Script API).
 *
 * Discovery limitation: only standalone GAS scripts are discoverable via Drive.
 * Container-bound scripts (attached to Docs/Sheets/Slides) are NOT returned by
 * listProjects — they are not separate Drive files.
 *
 * Requires: https://www.googleapis.com/auth/drive.readonly (discovery)
 *           https://www.googleapis.com/auth/script.projects (create/get)
 */

import { GASAuthOperations } from './gasAuthOperations.js';
import type { GASProject } from './gasTypes.js';

const GAS_SCRIPT_MIME = "application/vnd.google-apps.script";

/**
 * Manages GAS project discovery and creation operations.
 */
export class GASProjectOperations {
  private authOps: GASAuthOperations;

  constructor(authOps: GASAuthOperations) {
    this.authOps = authOps;
  }

  /**
   * List standalone GAS projects visible to the authenticated user.
   * Optionally filters by name substring.
   *
   * Note: Only standalone scripts appear here. Container-bound scripts
   * (bound to a Sheet, Doc, or Slide) do not appear as separate Drive files.
   */
  async listProjects(nameFilter?: string): Promise<GASProject[]> {
    return this.authOps.makeDriveRequest(async (driveApi) => {
      // Build Drive query for GAS scripts
      let query = `mimeType='${GAS_SCRIPT_MIME}' and trashed=false`;
      if (nameFilter) {
        // Escape single quotes in the filter to avoid query injection
        const safe = nameFilter.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        query += ` and name contains '${safe}'`;
      }

      const response = await driveApi.files.list({
        q: query,
        fields: 'files(id,name,createdTime,modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
      });

      const files = response.data.files ?? [];
      console.error(`listProjects: found ${files.length} standalone GAS project(s)`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (files as any[]).map((f): GASProject => ({
        scriptId: f.id ?? '',
        title: f.name ?? '',
        createTime: f.createdTime ?? undefined,
        updateTime: f.modifiedTime ?? undefined,
      }));
    });
  }

  /**
   * Get the title of a GAS project by scriptId.
   * Returns null if the project cannot be found or permission is denied.
   */
  async getProjectTitle(scriptId: string): Promise<string | null> {
    try {
      return await this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (scriptApi.projects as any).get({ scriptId });
        return (response.data.title as string) ?? null;
      });
    } catch {
      return null; // Non-fatal — caller uses a fallback title
    }
  }

  /**
   * Create a new standalone GAS project with the given title.
   * Returns the new project's scriptId and title.
   */
  async createProject(title: string, parentId?: string): Promise<{ scriptId: string; title: string }> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      console.error(`createProject: creating "${title}"`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (scriptApi.projects as any).create({
        requestBody: { title, ...(parentId ? { parentId } : {}) },
      });

      const scriptId = response.data.scriptId as string | undefined;
      if (!scriptId) {
        throw new Error('createProject: API response missing scriptId');
      }

      console.error(`createProject: created ${scriptId} ("${title}")`);
      return { scriptId, title: (response.data.title as string) ?? title };
    });
  }

  /**
   * Permanently delete a GAS project via Drive API.
   * Used by E2E test teardown to clean up temp projects.
   */
  async trashProject(scriptId: string): Promise<void> {
    return this.authOps.makeDriveRequest(async (driveApi) => {
      await driveApi.files.delete({ fileId: scriptId });
    });
  }

  /**
   * Create a new Google Spreadsheet via Drive API.
   * Uses the existing drive scope — no new OAuth scope needed.
   * Returns the spreadsheetId (= Drive fileId).
   */
  async createSpreadsheet(title: string): Promise<string> {
    return this.authOps.makeDriveRequest(async (driveApi) => {
      console.error(`createSpreadsheet: creating "${title}"`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (driveApi.files as any).create({
        requestBody: {
          name: title,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        fields: 'id',
      });

      const spreadsheetId = response.data.id as string | undefined;
      if (!spreadsheetId) {
        throw new Error('createSpreadsheet: Drive API response missing file id');
      }

      console.error(`createSpreadsheet: created ${spreadsheetId} ("${title}")`);
      return spreadsheetId;
    });
  }

  /**
   * Get the parent spreadsheet ID for a container-bound script.
   * Returns null for standalone scripts or if the project cannot be found.
   */
  async getProjectParentId(scriptId: string): Promise<string | null> {
    try {
      return await this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (scriptApi.projects as any).get({ scriptId });
        return (response.data.parentId as string) ?? null;
      });
    } catch {
      return null;
    }
  }
}
