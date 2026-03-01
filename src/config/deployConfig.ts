/**
 * Deploy Configuration for mcp_gas_deploy
 *
 * Manages gas-deploy.json — stores deployment URLs and metadata per scriptId.
 * Auto-creates with empty defaults on first write.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DeploymentInfo {
  stagingUrl?: string;
  stagingDeploymentId?: string;
  stagingVersionNumber?: number;
  prodUrl?: string;
  prodDeploymentId?: string;
  prodVersionNumber?: number;
  headUrl?: string;       // HEAD deployment URL (ends in /dev) — used by exec
  headDeploymentId?: string;
  lastDeploy?: string; // ISO timestamp

  // Per-environment timestamps (written on deploy/promote)
  stagingDeployedAt?: string;           // ISO — set on every deploy/promote to staging
  prodDeployedAt?: string;              // ISO — set on every deploy/promote to prod

  // Consumer proxy projects (optional — set once in gas-deploy.json; never auto-written by deploy)
  userSymbol?: string;                  // Library namespace, e.g. "SheetsChat"
  stagingConsumerScriptId?: string;     // Staging consumer project scriptId
  stagingConsumerDeploymentId?: string; // Optional: staging consumer web-app deployment ID
  prodConsumerScriptId?: string;        // Prod consumer project scriptId
  prodConsumerDeploymentId?: string;    // Optional: prod consumer web-app deployment ID
}

export interface DeployConfig {
  [scriptId: string]: DeploymentInfo;
}

const CONFIG_FILENAME = 'gas-deploy.json';

function getConfigPath(localDir: string): string {
  return path.join(localDir, CONFIG_FILENAME);
}

export async function readDeployConfig(localDir: string): Promise<DeployConfig> {
  try {
    const content = await fs.readFile(getConfigPath(localDir), 'utf-8');
    return JSON.parse(content) as DeployConfig;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeDeployConfig(localDir: string, config: DeployConfig): Promise<void> {
  const configPath = getConfigPath(localDir);
  const tempPath = `${configPath}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(config, null, 2), 'utf-8');
    await fs.rename(tempPath, configPath);
  } catch (error: unknown) {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

export async function getDeploymentInfo(localDir: string, scriptId: string): Promise<DeploymentInfo> {
  const config = await readDeployConfig(localDir);
  return config[scriptId] ?? {};
}

export async function setDeploymentInfo(
  localDir: string,
  scriptId: string,
  info: Partial<DeploymentInfo>
): Promise<void> {
  const config = await readDeployConfig(localDir);
  config[scriptId] = { ...config[scriptId], ...info };
  await writeDeployConfig(localDir, config);
}
