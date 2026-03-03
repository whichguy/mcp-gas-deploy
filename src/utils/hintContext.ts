import type { DeploymentInfo } from '../config/deployConfig.js';

/** Build a compact state-context string for error hints. */
export function buildHintContext(
  deployInfo: DeploymentInfo | undefined,
  env?: 'staging' | 'prod'
): string {
  if (!deployInfo) return 'gas-deploy.json: not found or empty for this scriptId';
  const parts: string[] = [];
  if (env === 'staging' || !env) {
    parts.push(`staging: v${deployInfo.stagingVersionNumber ?? 'none'}, deployId=${deployInfo.stagingDeploymentId ?? 'none'}, slots=${deployInfo.stagingSlotIds?.length ?? 0}, activeSlot=${deployInfo.stagingActiveSlotIndex ?? 'none'}`);
  }
  if (env === 'prod' || !env) {
    parts.push(`prod: v${deployInfo.prodVersionNumber ?? 'none'}, deployId=${deployInfo.prodDeploymentId ?? 'none'}, slots=${deployInfo.prodSlotIds?.length ?? 0}, activeSlot=${deployInfo.prodActiveSlotIndex ?? 'none'}`);
  }
  if (deployInfo.userSymbol) parts.push(`consumer: userSymbol=${deployInfo.userSymbol}`);
  return parts.join(' | ');
}
