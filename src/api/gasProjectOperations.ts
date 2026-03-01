/**
 * Project Operations for mcp_gas_deploy
 *
 * Provides project discovery via the Google Drive API.
 * Only standalone GAS scripts are discoverable (mimeType: application/vnd.google-apps.script).
 * Container-bound scripts (attached to Docs/Sheets/Slides) are NOT returned — they
 * are not separate Drive files and cannot be discovered without a known scriptId.
 *
 * Requires: https://www.googleapis.com/auth/drive.readonly scope.
 */

import { GASAuthOperations } from './gasAuthOperations.js';
import type { GASProject } from './gasTypes.js';

const GAS_SCRIPT_MIME = "application/vnd.google-apps.script";

/**
 * Manages GAS project discovery operations via the Drive API.
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
}
