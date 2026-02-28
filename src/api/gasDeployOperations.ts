/**
 * Deployment Operations for mcp_gas_deploy
 *
 * Provides version and deployment management for Google Apps Script projects.
 * Standalone — no mcp_gas dependencies.
 */

import { GASAuthOperations } from './gasAuthOperations.js';
import { GASDeployment, GASVersion } from './gasTypes.js';

/**
 * Manages GAS deployment and version operations.
 */
export class GASDeployOperations {
  private authOps: GASAuthOperations;

  constructor(authOps: GASAuthOperations) {
    this.authOps = authOps;
  }

  /**
   * Create a version snapshot of the project.
   */
  async createVersion(scriptId: string, description?: string): Promise<GASVersion> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      const response = await scriptApi.projects.versions.create({
        scriptId,
        requestBody: {
          description: description ?? 'Version created by mcp-gas-deploy',
        },
      });

      console.error(`createVersion: created v${response.data.versionNumber} for ${scriptId}`);

      return {
        scriptId: response.data.scriptId ?? scriptId,
        versionNumber: response.data.versionNumber ?? 0,
        description: response.data.description ?? undefined,
        createTime: response.data.createTime ?? undefined,
      };
    });
  }

  /**
   * List all existing deployments for a project.
   */
  async listDeployments(scriptId: string): Promise<GASDeployment[]> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      const response = await scriptApi.projects.deployments.list({ scriptId });
      const deployments = response.data.deployments ?? [];
      console.error(`listDeployments: found ${deployments.length} deployments for ${scriptId}`);

      // Cast to any: googleapis Schema$Deployment type omits several documented fields
      return deployments.map((d): GASDeployment => {
        const raw = d as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        return {
          deploymentId: raw.deploymentId ?? '',
          versionNumber: raw.versionNumber ?? 0,
          description: raw.description ?? undefined,
          manifestFileName: raw.manifestFileName ?? undefined,
          updateTime: raw.updateTime ?? undefined,
          deploymentConfig: raw.deploymentConfig,
          entryPoints: raw.entryPoints,
        };
      });
    });
  }

  /**
   * Update an existing deployment to point to a different version.
   */
  async updateDeployment(
    scriptId: string,
    deploymentId: string,
    versionNumber: number
  ): Promise<GASDeployment> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      console.error(`updateDeployment: pinning ${deploymentId} to v${versionNumber}`);

      const response = await scriptApi.projects.deployments.update({
        scriptId,
        deploymentId,
        requestBody: {
          deploymentConfig: {
            manifestFileName: 'appsscript',
            versionNumber,
          },
        },
      });

      // Extract web app URL from entry points if present
      let webAppUrl: string | undefined;
      if (response.data.entryPoints) {
        const webApp = (response.data.entryPoints as Array<{
          entryPointType: string;
          webApp?: { url?: string };
        }>).find((ep) => ep.entryPointType === 'WEB_APP');
        webAppUrl = webApp?.webApp?.url ?? undefined;
      }

      console.error(`updateDeployment: updated ${deploymentId} successfully`);

      // Cast to any: googleapis Schema$Deployment type omits several documented fields
      const raw = response.data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        deploymentId: raw.deploymentId ?? deploymentId,
        versionNumber: raw.versionNumber ?? versionNumber,
        description: raw.description ?? undefined,
        manifestFileName: raw.manifestFileName ?? undefined,
        updateTime: raw.updateTime ?? undefined,
        webAppUrl,
      };
    });
  }

  /**
   * Find an existing HEAD deployment (versionNumber = 0) or create one.
   *
   * HEAD deployments serve the current HEAD revision at a /dev URL and are
   * required for ?_mcp_run=true exec. Versioned /exec deployments redirect
   * back to /exec even if you append /dev to the URL.
   */
  async getOrCreateHeadDeployment(
    scriptId: string,
    description = 'mcp-gas-deploy HEAD'
  ): Promise<GASDeployment> {
    const deployments = await this.listDeployments(scriptId);

    for (const d of deployments) {
      // HEAD deployments have versionNumber === 0 in deploymentConfig (no pinned version)
      const vn = d.deploymentConfig?.versionNumber ?? d.versionNumber;
      if (!vn) {
        let webAppUrl = d.webAppUrl;
        if (!webAppUrl && d.entryPoints) {
          const ep = d.entryPoints.find((e) => e.entryPointType === 'WEB_APP');
          webAppUrl = ep?.webApp?.url ?? undefined;
        }
        if (webAppUrl) {
          console.error(`getOrCreateHeadDeployment: found existing HEAD ${d.deploymentId}`);
          return { ...d, webAppUrl };
        }
      }
    }

    // No HEAD deployment found — create one (omit versionNumber for HEAD)
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      console.error(`getOrCreateHeadDeployment: creating HEAD deployment for ${scriptId}`);

      const response = await scriptApi.projects.deployments.create({
        scriptId,
        requestBody: {
          description,
          manifestFileName: 'appsscript',
        },
      });

      let webAppUrl: string | undefined;
      if (response.data.entryPoints) {
        const webApp = (response.data.entryPoints as Array<{
          entryPointType: string;
          webApp?: { url?: string };
        }>).find((ep) => ep.entryPointType === 'WEB_APP');
        webAppUrl = webApp?.webApp?.url ?? undefined;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = response.data as any;
      console.error(`getOrCreateHeadDeployment: created ${raw.deploymentId}, url=${webAppUrl}`);

      return {
        deploymentId: raw.deploymentId ?? '',
        versionNumber: 0,
        description: raw.description ?? undefined,
        manifestFileName: raw.manifestFileName ?? undefined,
        updateTime: raw.updateTime ?? undefined,
        webAppUrl,
      };
    });
  }

  /**
   * Create a new deployment pinned to the given version.
   */
  async createDeployment(
    scriptId: string,
    versionNumber: number,
    description: string
  ): Promise<GASDeployment> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      console.error(`createDeployment: creating deployment at v${versionNumber} for ${scriptId}`);

      const response = await scriptApi.projects.deployments.create({
        scriptId,
        requestBody: {
          versionNumber,
          description,
          manifestFileName: 'appsscript',
        },
      });

      // Extract web app URL from entry points if present
      let webAppUrl: string | undefined;
      if (response.data.entryPoints) {
        const webApp = (response.data.entryPoints as Array<{
          entryPointType: string;
          webApp?: { url?: string };
        }>).find((ep) => ep.entryPointType === 'WEB_APP');
        webAppUrl = webApp?.webApp?.url ?? undefined;
      }

      // Cast to any: googleapis Schema$Deployment type omits several documented fields
      const raw = response.data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      console.error(`createDeployment: created ${raw.deploymentId}`);

      return {
        deploymentId: raw.deploymentId ?? '',
        versionNumber: raw.versionNumber ?? versionNumber,
        description: raw.description ?? undefined,
        manifestFileName: raw.manifestFileName ?? undefined,
        updateTime: raw.updateTime ?? undefined,
        deploymentConfig: raw.deploymentConfig,
        entryPoints: raw.entryPoints,
        webAppUrl,
      };
    });
  }
}
