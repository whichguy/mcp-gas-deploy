/**
 * Deployment Operations for mcp_gas_deploy
 *
 * Provides version and deployment management for Google Apps Script projects.
 * Standalone — no mcp_gas dependencies.
 */

import { GASAuthOperations } from './gasAuthOperations.js';
import { EntryPoint, GASDeployment, GASVersion } from './gasTypes.js';

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

      const versionNumber = response.data.versionNumber;
      if (versionNumber == null) {
        throw new Error(`createVersion: API response missing versionNumber for ${scriptId}`);
      }
      console.error(`createVersion: created v${versionNumber} for ${scriptId}`);

      return {
        scriptId: response.data.scriptId ?? scriptId,
        versionNumber,
        description: response.data.description ?? undefined,
        createTime: response.data.createTime ?? undefined,
      };
    });
  }

  /**
   * List all saved version snapshots for a project.
   * GAS enforces a hard cap of 200 versions per project (enforced June 2024).
   * Versions cannot be deleted individually — monitor the budget via versionNumber count.
   */
  async listVersions(scriptId: string): Promise<GASVersion[]> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      const response = await scriptApi.projects.versions.list({ scriptId });
      const versions = response.data.versions ?? [];
      console.error(`listVersions: found ${versions.length} versions for ${scriptId}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (versions as any[]).map((v): GASVersion => ({
        scriptId: v.scriptId ?? scriptId,
        versionNumber: v.versionNumber ?? 0,
        description: v.description ?? undefined,
        createTime: v.createTime ?? undefined,
      }));
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

      // Cast to any[]: googleapis Schema$Deployment type omits several documented fields
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (deployments as any[]).map((raw): GASDeployment => {
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

      console.error(`updateDeployment: updated ${deploymentId} successfully`);

      // Cast to any: googleapis Schema$Deployment type omits several documented fields
      const raw = response.data as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      let webAppUrl: string | undefined;
      if (raw.entryPoints) {
        const webApp = (raw.entryPoints as EntryPoint[]).find(
          (ep) => ep.entryPointType === 'WEB_APP'
        );
        webAppUrl = webApp?.webApp?.url ?? undefined;
      }

      return {
        deploymentId: raw.deploymentId ?? deploymentId,
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
      // HEAD deployments have no pinned version — deploymentConfig.versionNumber is absent or 0
      const isHead = (d.deploymentConfig?.versionNumber ?? 0) === 0;
      if (isHead) {
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = response.data as any;

      let webAppUrl: string | undefined;
      if (raw.entryPoints) {
        const webApp = (raw.entryPoints as EntryPoint[]).find(
          (ep) => ep.entryPointType === 'WEB_APP'
        );
        webAppUrl = webApp?.webApp?.url ?? undefined;
      }

      console.error(`getOrCreateHeadDeployment: created ${raw.deploymentId}, url=${webAppUrl}`);

      return {
        deploymentId: raw.deploymentId ?? '',
        versionNumber: 0,
        description: raw.description ?? undefined,
        manifestFileName: raw.manifestFileName ?? undefined,
        updateTime: raw.updateTime ?? undefined,
        deploymentConfig: raw.deploymentConfig,
        entryPoints: raw.entryPoints,
        webAppUrl,
      };
    });
  }

  /**
   * Get the versionNumber of an existing deployment.
   * Throws if the deployment has no pinned versionNumber (HEAD-only deployment).
   */
  async getDeploymentVersionNumber(scriptId: string, deploymentId: string): Promise<number> {
    return this.authOps.makeAuthenticatedRequest(async (scriptApi) => {
      const response = await scriptApi.projects.deployments.get({ scriptId, deploymentId });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = response.data as any;
      const versionNumber: number | undefined = raw.deploymentConfig?.versionNumber;

      if (versionNumber == null || versionNumber === 0) {
        throw new Error(
          `getDeploymentVersionNumber: deployment ${deploymentId} has no pinned versionNumber (HEAD-only)`
        );
      }

      console.error(`getDeploymentVersionNumber: ${deploymentId} is pinned to v${versionNumber}`);
      return versionNumber;
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

      // Cast to any: googleapis Schema$Deployment type omits several documented fields
      const raw = response.data as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      // Extract web app URL from entry points if present
      let webAppUrl: string | undefined;
      if (raw.entryPoints) {
        const webApp = (raw.entryPoints as EntryPoint[]).find(
          (ep) => ep.entryPointType === 'WEB_APP'
        );
        webAppUrl = webApp?.webApp?.url ?? undefined;
      }

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
