/**
 * File Operations for mcp_gas_deploy
 *
 * Provides get/update for Google Apps Script project files.
 * Standalone — no mcp_gas dependencies.
 */

import { GASAuthOperations } from './gasAuthOperations.js';
import { GASFile } from './gasTypes.js';

/**
 * Manages file-level GAS project operations.
 */
export class GASFileOperations {
  private authOps: GASAuthOperations;

  constructor(authOps: GASAuthOperations) {
    this.authOps = authOps;
  }

  /**
   * Fetch all files from a GAS project.
   */
  async getProjectFiles(scriptId: string): Promise<GASFile[]> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      const response = await scriptApi.projects.getContent({ scriptId });
      const files = response.data.files ?? [];
      console.error(`getProjectFiles: fetched ${files.length} files from ${scriptId}`);
      return files as GASFile[];
    });
  }

  /**
   * Push files to a GAS project, replacing its content.
   * The GAS API replaces all files atomically — supply the complete file list.
   */
  async updateProjectFiles(scriptId: string, files: GASFile[]): Promise<GASFile[]> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      console.error(`updateProjectFiles: sending ${files.length} files to ${scriptId}`);

      const response = await scriptApi.projects.updateContent({
        scriptId,
        requestBody: {
          files: files.map((f) => ({
            name: f.name,
            type: f.type,
            source: f.source,
          })),
        },
      });

      const returnedFiles = response.data.files ?? [];
      console.error(`updateProjectFiles: server returned ${returnedFiles.length} files`);
      return returnedFiles as GASFile[];
    });
  }
}
