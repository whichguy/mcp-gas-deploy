/**
 * Property sync utility — copies ConfigManager-managed properties between GAS projects.
 *
 * Executes on BOTH source (read) and target (write) projects via execHelper.
 * PropertiesService is project-scoped, so both exec calls are required.
 *
 * V1 limitation: newly auto-created -source libraries have no exec path.
 * If exec fails on either project, returns an error result (non-fatal to promote).
 */

import { execInternal } from './execHelper.js';
import { MANAGED_PROPERTY_KEYS } from './deployConstants.js';
import type { SessionManager } from '../auth/sessionManager.js';

export interface PropertySyncResult {
  source: string;
  target: string;
  synced: string[];
  skipped: string[];    // MANAGED_PROPERTY_KEYS excluded
  deleted?: string[];   // reconcile mode: keys removed from target
  errors?: string[];
  consumerSync?: { synced: string[]; skipped: string[]; errors?: string[] };
}

/**
 * Sync ConfigManager-managed properties from source to target project.
 *
 * @param sourceScriptId - project to read properties from
 * @param targetScriptId - project to write properties to
 * @param sessionManager - for token retrieval
 * @param options - reconcile (delete target-only keys), consumer sync, headUrls
 */
export async function syncProperties(
  sourceScriptId: string,
  targetScriptId: string,
  sessionManager: SessionManager,
  options?: {
    reconcile?: boolean;
    consumerScriptId?: string;
    sourceHeadUrl?: string;
    targetHeadUrl?: string;
    consumerHeadUrl?: string;
  }
): Promise<PropertySyncResult> {
  const base: PropertySyncResult = {
    source: sourceScriptId,
    target: targetScriptId,
    synced: [],
    skipped: [],
  };

  // Step 1: Read properties from source
  const readJs = `return (function(){
  var sp = PropertiesService.getScriptProperties().getProperties();
  return sp;
})()`;

  const readResult = await execInternal(sourceScriptId, readJs, sessionManager, {
    headUrl: options?.sourceHeadUrl,
  });

  if (!readResult.success) {
    return {
      ...base,
      errors: [`Could not read source properties: ${readResult.error ?? 'exec failed'}. Property sync skipped.`],
    };
  }

  const allProps = (readResult.result ?? {}) as Record<string, string>;

  // Filter out managed/infrastructure keys
  const filteredProps: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(allProps)) {
    if (MANAGED_PROPERTY_KEYS.has(k)) {
      skipped.push(k);
    } else {
      filteredProps[k] = v;
    }
  }

  if (Object.keys(filteredProps).length === 0) {
    return { ...base, skipped };
  }

  // Step 2: Batch write to target (single exec call — avoids quota limits)
  const writeJs = `return (function(){
  var props = ${JSON.stringify(filteredProps)};
  PropertiesService.getScriptProperties().setProperties(props, false);
  return Object.keys(props).length;
})()`;

  const writeResult = await execInternal(targetScriptId, writeJs, sessionManager, {
    headUrl: options?.targetHeadUrl,
  });

  if (!writeResult.success) {
    return {
      ...base,
      skipped,
      errors: [`Could not write target properties: ${writeResult.error ?? 'exec failed'}. Property sync skipped.`],
    };
  }

  const synced = Object.keys(filteredProps);
  let deleted: string[] | undefined;

  // Step 3: Optional reconcile — delete target-only keys not in source
  if (options?.reconcile) {
    const readTargetJs = `return (function(){
  return PropertiesService.getScriptProperties().getProperties();
})()`;

    const targetReadResult = await execInternal(targetScriptId, readTargetJs, sessionManager, {
      headUrl: options?.targetHeadUrl,
    });

    if (targetReadResult.success) {
      const targetProps = (targetReadResult.result ?? {}) as Record<string, string>;
      const toDelete = Object.keys(targetProps).filter(
        k => !(k in filteredProps) && !MANAGED_PROPERTY_KEYS.has(k)
      );

      if (toDelete.length > 0) {
        const deleteJs = `return (function(){
  var keys = ${JSON.stringify(toDelete)};
  for (var i = 0; i < keys.length; i++) {
    PropertiesService.getScriptProperties().deleteProperty(keys[i]);
  }
  return keys.length;
})()`;
        const deleteResult = await execInternal(targetScriptId, deleteJs, sessionManager, {
          headUrl: options?.targetHeadUrl,
        });
        if (deleteResult.success) {
          deleted = toDelete;
        }
      }
    }
  }

  // Step 4: Optional consumer sync
  let consumerSync: PropertySyncResult['consumerSync'] | undefined;
  if (options?.consumerScriptId) {
    const consumerWriteJs = `return (function(){
  var props = ${JSON.stringify(filteredProps)};
  PropertiesService.getScriptProperties().setProperties(props, false);
  return Object.keys(props).length;
})()`;

    const consumerResult = await execInternal(options.consumerScriptId, consumerWriteJs, sessionManager, {
      headUrl: options?.consumerHeadUrl,
    });

    consumerSync = consumerResult.success
      ? { synced, skipped: [] }
      : { synced: [], skipped: [], errors: [`Consumer sync failed: ${consumerResult.error ?? 'unknown'}`] };
  }

  return {
    source: sourceScriptId,
    target: targetScriptId,
    synced,
    skipped,
    deleted,
    consumerSync,
  };
}
