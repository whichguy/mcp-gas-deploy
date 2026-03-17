/**
 * Sheet sync utility — copies spreadsheet tabs from source to target
 * by executing GAS code on the dev project.
 *
 * Uses SpreadsheetApp.openById() + sheet.copyTo() — no REST equivalent
 * preserves all formatting, formulas, and data validation.
 *
 * Ported from mcp_gas/src/tools/deploy.ts lines 1095-1160.
 */

import { execInternal } from './execHelper.js';
import { SPREADSHEET_ID_RE } from './deployConstants.js';
import type { SessionManager } from '../auth/sessionManager.js';

export type SheetSyncMode = 'smart' | 'replace_all' | 'add_new_only' | 'off';

export interface SheetSyncResult {
  source: string;
  target: string;
  synced: string[];      // sheets overwritten
  added: string[];       // new sheets copied
  preserved: string[];   // existing sheets left untouched
  skipped: string[];     // target-only sheets left in place
  error?: string;
}

const VALID_SYNC_MODES: SheetSyncMode[] = ['smart', 'replace_all', 'add_new_only', 'off'];

/**
 * Sync spreadsheet tabs from source to target via GAS execution on the dev project.
 *
 * @param sourceSpreadsheetId - source spreadsheet Drive file ID
 * @param targetSpreadsheetId - target spreadsheet Drive file ID
 * @param mode - sync mode controlling which sheets are overwritten
 * @param execScriptId - dev project scriptId (has SpreadsheetApp authorization)
 * @param sessionManager - for token retrieval
 * @param options - optional headUrl fallback, timeout
 */
export async function syncSheets(
  sourceSpreadsheetId: string,
  targetSpreadsheetId: string,
  mode: SheetSyncMode,
  execScriptId: string,
  sessionManager: SessionManager,
  options?: { headUrl?: string; timeoutMs?: number }
): Promise<SheetSyncResult> {
  const base: SheetSyncResult = {
    source: sourceSpreadsheetId,
    target: targetSpreadsheetId,
    synced: [],
    added: [],
    preserved: [],
    skipped: [],
  };

  if (mode === 'off') {
    return base;
  }

  if (!VALID_SYNC_MODES.includes(mode)) {
    return {
      ...base,
      error: `Invalid sync mode "${mode}". Must be one of: ${VALID_SYNC_MODES.join(', ')}`,
    };
  }

  // Validate spreadsheet IDs before interpolation
  if (!SPREADSHEET_ID_RE.test(sourceSpreadsheetId)) {
    return { ...base, error: `Invalid source spreadsheetId: "${sourceSpreadsheetId}"` };
  }
  if (!SPREADSHEET_ID_RE.test(targetSpreadsheetId)) {
    return { ...base, error: `Invalid target spreadsheetId: "${targetSpreadsheetId}"` };
  }

  // Build GAS JS string — interpolated values use JSON.stringify for safety
  // (belt-and-suspenders: IDs already validated by SPREADSHEET_ID_RE above)
  const jsStatement = `
return (function() {
  var source = SpreadsheetApp.openById(${JSON.stringify(sourceSpreadsheetId)});
  var target = SpreadsheetApp.openById(${JSON.stringify(targetSpreadsheetId)});
  var mode = ${JSON.stringify(mode)};
  var sourceSheets = source.getSheets();
  var targetSheets = target.getSheets();
  var targetNames = targetSheets.map(function(s) { return s.getName(); });
  var synced = [], added = [], skipped = [], preserved = [];

  for (var i = 0; i < sourceSheets.length; i++) {
    var srcSheet = sourceSheets[i];
    var name = srcSheet.getName();
    var targetIdx = targetNames.indexOf(name);
    var copied;

    if (targetIdx === -1) {
      // Sheet absent from target: always add (regardless of mode)
      copied = srcSheet.copyTo(target);
      copied.setName(name);
      added.push(name);
    } else if (mode === 'replace_all' || (mode === 'smart' && /^_|(_defaults|_template)$/i.test(name))) {
      // App-owned (template) sheet: overwrite on every deploy
      copied = srcSheet.copyTo(target);
      target.deleteSheet(targetSheets[targetIdx]);
      copied.setName(name);
      synced.push(name);
    } else {
      // User-owned sheet or add_new_only mode: preserve operator customization
      preserved.push(name);
    }
  }

  // Target-only sheets (not in source at all)
  var sourceNames = sourceSheets.map(function(s) { return s.getName(); });
  for (var j = 0; j < targetNames.length; j++) {
    if (sourceNames.indexOf(targetNames[j]) === -1) {
      skipped.push(targetNames[j]);
    }
  }

  return { synced: synced, added: added, skipped: skipped, preserved: preserved };
})()
  `.trim();

  const execResult = await execInternal(execScriptId, jsStatement, sessionManager, {
    headUrl: options?.headUrl,
    timeoutMs: options?.timeoutMs,
  });

  if (!execResult.success) {
    return {
      ...base,
      error: `Sheet sync exec failed: ${execResult.error ?? 'unknown'}`,
    };
  }

  // Parse result
  const data = execResult.result as {
    synced?: string[];
    added?: string[];
    preserved?: string[];
    skipped?: string[];
  } | null;

  return {
    source: sourceSpreadsheetId,
    target: targetSpreadsheetId,
    synced: data?.synced ?? [],
    added: data?.added ?? [],
    preserved: data?.preserved ?? [],
    skipped: data?.skipped ?? [],
  };
}
