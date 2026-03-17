/**
 * File preparation utilities for promoting files to -source libraries.
 * Pure functions — no API calls, no side-effects.
 *
 * Ported from mcp_gas/src/utils/deployUtils.ts:
 *   stripMcpEnvironments, enforceDeployFileOrder, prepareFilesForDeploy
 */

import type { GASFile } from '../api/gasTypes.js';

const DEPLOY_CRITICAL_ORDER = [
  'common-js/require',
  'common-js/ConfigManager',
  'common-js/__mcp_exec',
] as const;

/**
 * Strip mcp_environments from appsscript.json before pushing to -source libraries.
 * mcp_environments is dev-only tracking metadata that must not reach staging/prod.
 */
export function stripMcpEnvironments(files: GASFile[]): GASFile[] {
  return files.map((f: GASFile) => {
    if (f.name !== 'appsscript' || !f.source) return f;
    try {
      const json = JSON.parse(f.source);
      if (!json.mcp_environments) return f;
      const { mcp_environments: _removed, ...rest } = json;
      return { ...f, source: JSON.stringify(rest, null, 2) };
    } catch { return f; }
  });
}

/**
 * Enforce critical CommonJS file ordering before pushing to staging/prod.
 * Guarantees:
 *   [0] common-js/require       — bootstraps the module system
 *   [1] common-js/ConfigManager — available to all modules at load time
 *   [2] common-js/__mcp_exec    — MCP exec infrastructure
 *   [3..] remaining common-js/* in API order
 *   [n..] non-common-js files   in API order
 *
 * Throws if any critical file is absent.
 */
export function enforceDeployFileOrder(files: GASFile[]): GASFile[] {
  const criticalFiles = DEPLOY_CRITICAL_ORDER.map(baseName => {
    // Match by exact name first, then by final path component (e.g. "require" matches "common-js/require")
    const exactFile = files.find(f => f.name === baseName);
    const suffix = baseName.split('/').pop()!;
    const suffixFile = exactFile ?? files.find(
      f => f.name.startsWith('common-js/') && f.name.endsWith(`/${suffix}`)
    );
    if (!suffixFile) {
      throw new Error(
        `[enforceDeployFileOrder] Required file "${baseName}" is missing from source project. ` +
        `Cannot deploy without the CommonJS module system.`
      );
    }
    return suffixFile;
  });

  const criticalActualNames = new Set(criticalFiles.map(f => f.name));

  const otherCommonJs = files.filter(
    f => f.name.startsWith('common-js/') && !criticalActualNames.has(f.name)
  );
  const nonCommonJs = files.filter(f => !f.name.startsWith('common-js/'));

  // Assert no common-js files were lost
  const inputCommonJsCount = files.filter(f => f.name.startsWith('common-js/')).length;
  const outputCommonJsCount = criticalFiles.length + otherCommonJs.length;
  if (inputCommonJsCount !== outputCommonJsCount) {
    throw new Error(
      `[enforceDeployFileOrder] BUG: ${inputCommonJsCount} common-js files in input but ` +
      `${outputCommonJsCount} in output — ${inputCommonJsCount - outputCommonJsCount} lost`
    );
  }

  return [...criticalFiles, ...otherCommonJs, ...nonCommonJs];
}

/**
 * Prepare source files for cross-project deploy:
 * 1. Strip mcp_environments from appsscript.json
 * 2. Enforce critical common-js ordering
 */
export function prepareFilesForDeploy(files: GASFile[]): GASFile[] {
  return enforceDeployFileOrder(stripMcpEnvironments(files));
}
