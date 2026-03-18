/**
 * Bootstrap Config for mcp_gas_deploy
 *
 * Stores the token broker web app URL used by the GAS bootstrap auth path.
 * Follows the same config search pattern as loadOAuthConfig() in oauthClient.ts —
 * kept separate since these are logically distinct configs that may diverge.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface BootstrapConfig {
  tokenBrokerUrl: string;
}

/**
 * Load bootstrap config from the standard search path.
 *
 * Search order (mirrors loadOAuthConfig):
 *   1. <cwd>/.mcp-gas/bootstrap-config.json
 *   2. ~/.config/mcp-gas/bootstrap-config.json
 *
 * Returns null if not found in any location.
 */
export async function loadBootstrapConfig(): Promise<BootstrapConfig | null> {
  const configPaths = [
    path.join(process.cwd(), '.mcp-gas', 'bootstrap-config.json'),
    path.join(os.homedir(), '.config', 'mcp-gas', 'bootstrap-config.json'),
  ];

  for (const p of configPaths) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(content) as Partial<BootstrapConfig>;
      if (parsed.tokenBrokerUrl) {
        return { tokenBrokerUrl: parsed.tokenBrokerUrl };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Save bootstrap config to <cwd>/.mcp-gas/bootstrap-config.json.
 * Writes atomically (tmp + rename) with mode 0o600.
 */
export async function saveBootstrapConfig(cwd: string, tokenBrokerUrl: string): Promise<void> {
  const configDir = path.join(cwd, '.mcp-gas');
  const configPath = path.join(configDir, 'bootstrap-config.json');
  const tempPath = `${configPath}.tmp`;

  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(tempPath, JSON.stringify({ tokenBrokerUrl }, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, configPath);
}
