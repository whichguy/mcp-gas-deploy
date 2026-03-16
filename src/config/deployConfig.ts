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

  // scripts.run support (set by fork tool)
  gcpSwitched?: boolean;              // true when GCP project switch succeeded — exec uses scripts.run
  spreadsheetId?: string;             // bound spreadsheet ID for context passing (optional)

  // Circular buffer slots (auto-managed — never set manually)
  // Staging slots: up to 4 source deployment slot IDs (0-indexed, fills in order: 0→1→2→3→cycle)
  stagingSlotIds?: string[];                        // source deployment slot IDs (slots 1–4, 0-indexed)
  stagingSlotVersions?: number[];                   // source GAS version served by each slot
  stagingSlotDescriptions?: string[];               // ISO timestamps — when each slot was last written
  stagingSlotConsumerVersions?: (number | null)[];  // consumer version deployed alongside each source slot (null if no consumer)
  stagingActiveSlotIndex?: number;                  // index of slot the pointer currently serves (0–3)

  // Prod slots (same shape as staging — written on promote)
  prodSlotIds?: string[];
  prodSlotVersions?: number[];
  prodSlotDescriptions?: string[];
  prodSlotConsumerVersions?: (number | null)[];
  prodActiveSlotIndex?: number;
}

export interface DeployConfig {
  [scriptId: string]: DeploymentInfo;
}

/** Threshold for staleness hints — 48 hours. Shared by deployTool and statusTool. */
export const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

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
