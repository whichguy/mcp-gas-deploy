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
  lastDeploy?: string; // ISO timestamp
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
  } catch (error) {
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
