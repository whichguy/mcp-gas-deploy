/**
 * Trigger Tool for mcp-gas-deploy
 *
 * Manages GAS installable triggers (list/create/delete) via ScriptApp APIs
 * executed through the web app HEAD deployment URL. Unlike execTool, trigger
 * operations don't auto-push files — they're project-level ScriptApp calls.
 */

import path from 'node:path';
import os from 'node:os';
import { GASDeployOperations } from '../api/gasDeployOperations.js';
import { getDeploymentInfo, setDeploymentInfo } from '../config/deployConfig.js';
import { SessionManager } from '../auth/sessionManager.js';
import { SCRIPT_ID_PATTERN, TRIGGER_ID_PATTERN, FUNCTION_PATTERN } from '../utils/validation.js';
import { executeRawJs, escapeGasString } from '../utils/gasExecutor.js';

// --- Types ---

export interface TriggerToolParams {
  scriptId: string;
  localDir?: string;
  action: 'list' | 'create' | 'delete';

  // List
  detailed?: boolean;

  // Create
  functionName?: string;
  triggerType?: 'time' | 'spreadsheet' | 'form' | 'calendar' | 'document';

  // Time options
  interval?: 'minutes' | 'hours' | 'days' | 'weeks' | 'monthly' | 'specific';
  intervalValue?: number;
  specificDate?: string;
  weekDay?: string;
  monthDay?: number;
  hour?: number;
  minute?: number;
  timezone?: string;

  // Spreadsheet
  spreadsheetId?: string;
  spreadsheetEvent?: 'onOpen' | 'onEdit' | 'onChange' | 'onFormSubmit' | 'onSelectionChange';

  // Form
  formId?: string;
  formEvent?: 'onFormSubmit' | 'onFormOpen';

  // Calendar
  calendarId?: string;

  // Document
  documentId?: string;

  // Delete
  triggerId?: string;
  deleteAll?: boolean;
}

export interface TriggerInfo {
  triggerId?: string;
  functionName: string;
  triggerType: string;
  eventType?: string;
  sourceId?: string;
}

export interface TriggerToolResult {
  success: boolean;
  action: string;
  triggers?: TriggerInfo[];
  totalTriggers?: number;
  triggerId?: string;
  triggerType?: string;
  functionName?: string;
  deleted?: number;
  error?: string;
  hints: Record<string, string>;
}

// --- Validation ---

const VALID_INTERVALS = ['minutes', 'hours', 'days', 'weeks', 'monthly', 'specific'] as const;
const VALID_MINUTES = [1, 5, 10, 15, 30];
const VALID_SPREADSHEET_EVENTS = ['onOpen', 'onEdit', 'onChange', 'onFormSubmit', 'onSelectionChange'] as const;
const VALID_FORM_EVENTS = ['onFormSubmit', 'onFormOpen'] as const;
const VALID_WEEK_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;

function isValidEnum<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

// --- IIFE Builders ---

// Each builder generates a self-contained IIFE that calls ScriptApp APIs and returns a plain object.
// The __mcp_exec.gs handler serializes the return value to JSON, so we avoid double-stringifying.

function buildListIife(detailed: boolean): string {
  return `(function() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var result = triggers.map(function(t) {
      var info = {
        functionName: t.getHandlerFunction(),
        triggerType: String(t.getTriggerSource()),
        eventType: String(t.getEventType())
      };
      ${detailed ? `info.triggerId = t.getUniqueId();
      try { info.sourceId = t.getTriggerSourceId(); } catch(e) {}` : ''}
      return info;
    });
    return { success: true, triggers: result, totalTriggers: result.length };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

function buildDeleteAllIife(): string {
  return `(function() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var count = triggers.length;
    for (var i = 0; i < triggers.length; i++) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
    return { success: true, deleted: count };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

function buildDeleteByIdIife(triggerId: string): string {
  // escapeGasString prevents injection via triggerId
  const safeId = escapeGasString(triggerId);
  return `(function() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var found = false;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getUniqueId() === '${safeId}') {
        ScriptApp.deleteTrigger(triggers[i]);
        found = true;
        break;
      }
    }
    if (!found) return { success: false, error: 'Trigger not found: ${safeId}' };
    return { success: true, deleted: 1 };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

function buildDeleteByFunctionIife(functionName: string): string {
  // escapeGasString prevents injection via functionName
  const safeName = escapeGasString(functionName);
  return `(function() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var deleted = 0;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === '${safeName}') {
        ScriptApp.deleteTrigger(triggers[i]);
        deleted++;
      }
    }
    if (deleted === 0) return { success: false, error: 'No triggers found for function: ${safeName}' };
    return { success: true, deleted: deleted };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

// Builds the ScriptApp.newTrigger IIFE for time-based triggers using the correct GAS ClockTriggerBuilder API
function buildTimeCreateIife(params: TriggerToolParams): string {
  const safeFn = escapeGasString(params.functionName!);
  const { interval, intervalValue, specificDate, weekDay, monthDay, hour, minute, timezone } = params;

  let chain = `ScriptApp.newTrigger('${safeFn}').timeBased()`;

  switch (interval) {
    case 'minutes':
      chain += `.everyMinutes(${intervalValue})`;
      break;
    case 'hours':
      chain += `.everyHours(${intervalValue})`;
      break;
    case 'days':
      chain += `.everyDays(${intervalValue ?? 1})`;
      if (hour !== undefined) chain += `.atHour(${hour})`;
      if (minute !== undefined) chain += `.nearMinute(${minute})`;
      break;
    case 'weeks':
      chain += `.everyWeeks(${intervalValue ?? 1})`;
      if (weekDay) chain += `.onWeekDay(ScriptApp.WeekDay.${escapeGasString(weekDay)})`;
      if (hour !== undefined) chain += `.atHour(${hour})`;
      if (minute !== undefined) chain += `.nearMinute(${minute})`;
      break;
    case 'monthly':
      if (monthDay !== undefined) chain += `.onMonthDay(${monthDay})`;
      if (hour !== undefined) chain += `.atHour(${hour})`;
      if (minute !== undefined) chain += `.nearMinute(${minute})`;
      break;
    case 'specific':
      chain += `.at(new Date('${escapeGasString(specificDate!)}'))`;
      break;
  }

  if (timezone && interval !== 'specific') {
    chain += `.inTimezone('${escapeGasString(timezone)}')`;
  }

  return `(function() {
  try {
    var trigger = ${chain}.create();
    return {
      success: true,
      triggerId: trigger.getUniqueId(),
      triggerType: 'time',
      functionName: '${safeFn}'
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

// Builds the ScriptApp.newTrigger IIFE for spreadsheet triggers
function buildSpreadsheetCreateIife(params: TriggerToolParams): string {
  const safeFn = escapeGasString(params.functionName!);
  const ssRef = params.spreadsheetId
    ? `SpreadsheetApp.openById('${escapeGasString(params.spreadsheetId)}')`
    : 'SpreadsheetApp.getActive()';

  let chain = `ScriptApp.newTrigger('${safeFn}').forSpreadsheet(${ssRef})`;

  switch (params.spreadsheetEvent) {
    case 'onOpen': chain += '.onOpen()'; break;
    case 'onEdit': chain += '.onEdit()'; break;
    case 'onChange': chain += '.onChange()'; break;
    case 'onFormSubmit': chain += '.onFormSubmit()'; break;
    case 'onSelectionChange': chain += '.onSelectionChange()'; break;
  }

  return `(function() {
  try {
    var trigger = ${chain}.create();
    return {
      success: true,
      triggerId: trigger.getUniqueId(),
      triggerType: 'spreadsheet',
      functionName: '${safeFn}'
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

// Builds the ScriptApp.newTrigger IIFE for form triggers
function buildFormCreateIife(params: TriggerToolParams): string {
  const safeFn = escapeGasString(params.functionName!);
  const safeFormId = escapeGasString(params.formId!);

  let chain = `ScriptApp.newTrigger('${safeFn}').forForm(FormApp.openById('${safeFormId}'))`;

  switch (params.formEvent) {
    case 'onFormSubmit': chain += '.onFormSubmit()'; break;
    case 'onFormOpen': chain += '.onOpen()'; break;
  }

  return `(function() {
  try {
    var trigger = ${chain}.create();
    return {
      success: true,
      triggerId: trigger.getUniqueId(),
      triggerType: 'form',
      functionName: '${safeFn}'
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

// Builds the ScriptApp.newTrigger IIFE for calendar triggers (onEventUpdated only)
function buildCalendarCreateIife(params: TriggerToolParams): string {
  const safeFn = escapeGasString(params.functionName!);
  const calRef = params.calendarId
    ? (params.calendarId === 'primary'
      ? 'CalendarApp.getDefaultCalendar()'
      : `CalendarApp.getCalendarById('${escapeGasString(params.calendarId)}')`)
    : 'CalendarApp.getDefaultCalendar()';

  return `(function() {
  try {
    var trigger = ScriptApp.newTrigger('${safeFn}').forCalendar(${calRef}).onEventUpdated().create();
    return {
      success: true,
      triggerId: trigger.getUniqueId(),
      triggerType: 'calendar',
      functionName: '${safeFn}'
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

// Builds the ScriptApp.newTrigger IIFE for document triggers (onOpen only)
function buildDocumentCreateIife(params: TriggerToolParams): string {
  const safeFn = escapeGasString(params.functionName!);
  const safeDocId = escapeGasString(params.documentId!);

  return `(function() {
  try {
    var trigger = ScriptApp.newTrigger('${safeFn}').forDocument(DocumentApp.openById('${safeDocId}')).onOpen().create();
    return {
      success: true,
      triggerId: trigger.getUniqueId(),
      triggerType: 'document',
      functionName: '${safeFn}'
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})()`;
}

// --- Tool Definition ---

export const TRIGGER_TOOL_DEFINITION = {
  name: 'trigger',
  description: `Manage GAS installable triggers — list, create, and delete time-based or event-driven triggers.

Requirements:
- Web app deployment must exist (HEAD deployment URL needed).
- For create: the target function must be globally accessible. In CommonJS projects,
  use __events__.fnName = handler inside _main() with loadNow: true.
- deleteAll removes ALL project triggers, not just ones created by this tool.
- Max 20 triggers per user per script.

Examples:
  trigger({scriptId, action: "list", detailed: true})
  trigger({scriptId, action: "create", functionName: "onTimer", triggerType: "time", interval: "hours", intervalValue: 1})
  trigger({scriptId, action: "delete", functionName: "onTimer"})`,
  annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: { type: 'string', description: 'Google Apps Script project ID' },
      localDir: { type: 'string', description: 'Local directory (only to find gas-deploy.json for headUrl)' },
      action: {
        type: 'string',
        enum: ['list', 'create', 'delete'],
        description: 'Operation to perform',
      },

      // List
      detailed: { type: 'boolean', description: 'Include trigger IDs and event types in list output' },

      // Create
      functionName: { type: 'string', description: 'Function to call when trigger fires (required for create)' },
      triggerType: {
        type: 'string',
        enum: ['time', 'spreadsheet', 'form', 'calendar', 'document'],
        description: 'Type of trigger to create',
      },

      // Time options
      interval: {
        type: 'string',
        enum: ['minutes', 'hours', 'days', 'weeks', 'monthly', 'specific'],
        description: 'Time interval type',
      },
      intervalValue: { type: 'number', description: 'Interval value (minutes: 1/5/10/15/30, hours: 1-24, days/weeks: 1+)' },
      specificDate: { type: 'string', description: 'ISO date string for one-time triggers' },
      weekDay: { type: 'string', enum: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'], description: 'Day of week for weekly triggers' },
      monthDay: { type: 'number', description: 'Day of month (1-31) for monthly triggers' },
      hour: { type: 'number', description: 'Hour (0-23) for daily/weekly/monthly triggers' },
      minute: { type: 'number', description: 'Minute (0-59) for daily/weekly/monthly triggers' },
      timezone: { type: 'string', description: 'Timezone (e.g. "America/New_York")' },

      // Spreadsheet
      spreadsheetId: { type: 'string', description: 'Spreadsheet ID (default: active spreadsheet)' },
      spreadsheetEvent: {
        type: 'string',
        enum: ['onOpen', 'onEdit', 'onChange', 'onFormSubmit', 'onSelectionChange'],
        description: 'Spreadsheet event type',
      },

      // Form
      formId: { type: 'string', description: 'Form ID (required for form triggers)' },
      formEvent: {
        type: 'string',
        enum: ['onFormSubmit', 'onFormOpen'],
        description: 'Form event type',
      },

      // Calendar
      calendarId: { type: 'string', description: 'Calendar ID (default: primary calendar)' },

      // Document
      documentId: { type: 'string', description: 'Document ID (required for document triggers)' },

      // Delete
      triggerId: { type: 'string', description: 'Trigger unique ID (from list with detailed=true)' },
      deleteAll: { type: 'boolean', description: 'Delete ALL project triggers (use with caution)' },

      // LLM guidance
      llmGuidance: {
        type: 'object',
        description: JSON.stringify({
          operations: 'list (detailed:true for IDs) | create (triggerType+options) | delete (triggerId/functionName/deleteAll)',
          triggerTypes: 'time: scheduled | spreadsheet: onEdit/onChange | form: onFormSubmit | calendar: onEventUpdated | document: onOpen',
          limitations: 'Max 20 triggers/user/script | calendar=onEventUpdated only | Docs=onOpen only | no addon/gmail (use manifest)',
          commonjs: 'Target function must be globally visible. In CommonJS: __events__.fnName = handler inside _main() with loadNow: true',
          workflow: 'list first → create with specific type → verify with list → delete by triggerId or functionName',
        }),
      },
    },
    required: ['scriptId', 'action'],
  },
};

// --- Handler ---

export async function handleTriggerTool(
  params: TriggerToolParams,
  sessionManager: SessionManager,
  deployOps: GASDeployOperations,
): Promise<TriggerToolResult> {
  const { scriptId, action } = params;

  try {
    // Validate scriptId
    if (!SCRIPT_ID_PATTERN.test(scriptId)) {
      return {
        success: false, action,
        error: 'Invalid scriptId format',
        hints: { fix: 'scriptId must be 20+ alphanumeric characters, hyphens, or underscores' },
      };
    }

    // Auth check
    const token = await sessionManager.getValidToken();
    if (!token) {
      return {
        success: false, action,
        error: 'Not authenticated',
        hints: { fix: "Run auth with action='login' first" },
      };
    }

    // headUrl resolution: gas-deploy.json → getOrCreateHeadDeployment fallback
    // Falls back to API if no local config — trigger ops don't require localDir
    const resolvedDir = params.localDir
      ? path.resolve(params.localDir)
      : path.join(os.homedir(), 'gas-projects', scriptId);

    let headUrl: string | undefined;
    try {
      const deployInfo = await getDeploymentInfo(resolvedDir, scriptId);
      headUrl = deployInfo.headUrl;
    } catch {
      // localDir may not exist — that's fine for trigger ops
    }

    if (!headUrl) {
      try {
        const headDeployment = await deployOps.getOrCreateHeadDeployment(scriptId);
        if (!headDeployment.webAppUrl) {
          return {
            success: false, action,
            error: 'HEAD deployment created but returned no web app URL',
            hints: { fix: 'Ensure the script has a web app entry point configured in appsscript.json (executeAs + access), then run deploy' },
          };
        }
        headUrl = headDeployment.webAppUrl;

        // Cache headUrl if localDir exists (non-fatal)
        try {
          await setDeploymentInfo(resolvedDir, scriptId, {
            headUrl,
            headDeploymentId: headDeployment.deploymentId,
          });
        } catch { /* localDir may not exist — ignore */ }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false, action,
          error: `Failed to get HEAD deployment: ${message}`,
          hints: { fix: 'Ensure the script has a web app entry point configured in appsscript.json (executeAs + access), then run deploy' },
        };
      }
    }

    switch (action) {
      case 'list':
        return await handleList(params, headUrl, token);
      case 'create':
        return await handleCreate(params, headUrl, token);
      case 'delete':
        return await handleDelete(params, headUrl, token);
      default:
        return {
          success: false, action: String(action),
          error: `Unknown action: ${action}`,
          hints: { fix: 'Valid actions: list, create, delete' },
        };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, action,
      error: `Unexpected error: ${message}`,
      hints: { fix: 'Check authentication and deployment configuration' },
    };
  }
}

// --- Action Handlers ---

async function handleList(params: TriggerToolParams, headUrl: string, token: string): Promise<TriggerToolResult> {
  const iife = buildListIife(params.detailed ?? false);
  const rawResult = await executeRawJs(iife, headUrl, token);

  if (!rawResult.success) {
    return {
      success: false, action: 'list',
      error: rawResult.error,
      hints: rawResult.error?.includes('browser authorization')
        ? { fix: `Visit ${headUrl} in Chrome signed in as script owner, then retry` }
        : { fix: 'Check authentication and deployment URL' },
    };
  }

  // rawResult.result is the plain object returned by the IIFE
  // Handle edge case: if __mcp_exec.gs double-serializes, result may be a string
  let data = rawResult.result as { success?: boolean; triggers?: TriggerInfo[]; totalTriggers?: number; error?: string };
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* use as-is */ }
  }

  if (!data?.success) {
    return {
      success: false, action: 'list',
      error: data?.error ?? 'Failed to list triggers',
      hints: { fix: 'Check script permissions and deployment configuration' },
    };
  }

  const totalTriggers = data.totalTriggers ?? data.triggers?.length ?? 0;
  return {
    success: true, action: 'list',
    triggers: data.triggers ?? [],
    totalTriggers,
    hints: {
      next: totalTriggers > 0
        ? `Found ${totalTriggers} trigger(s).${params.detailed ? '' : ' Use detailed=true for trigger IDs needed for deletion.'}`
        : 'No triggers found.',
    },
  };
}

async function handleCreate(params: TriggerToolParams, headUrl: string, token: string): Promise<TriggerToolResult> {
  // Validate required params
  if (!params.functionName) {
    return {
      success: false, action: 'create',
      error: 'functionName is required for create',
      hints: { fix: 'functionName is required — specify the function to call when trigger fires' },
    };
  }
  if (!FUNCTION_PATTERN.test(params.functionName)) {
    return {
      success: false, action: 'create',
      error: 'Invalid functionName format',
      hints: { fix: 'functionName must be a valid JavaScript identifier (letters, digits, _, $)' },
    };
  }

  if (!params.triggerType) {
    return {
      success: false, action: 'create',
      error: 'triggerType is required for create',
      hints: { fix: 'triggerType is required: time, spreadsheet, form, calendar, or document' },
    };
  }

  // Build type-specific IIFE
  let iife: string;
  const validationError = validateCreateParams(params);
  if (validationError) return validationError;

  switch (params.triggerType) {
    case 'time':
      iife = buildTimeCreateIife(params);
      break;
    case 'spreadsheet':
      iife = buildSpreadsheetCreateIife(params);
      break;
    case 'form':
      iife = buildFormCreateIife(params);
      break;
    case 'calendar':
      iife = buildCalendarCreateIife(params);
      break;
    case 'document':
      iife = buildDocumentCreateIife(params);
      break;
    default:
      return {
        success: false, action: 'create',
        error: `Unsupported trigger type: ${params.triggerType}`,
        hints: { fix: 'Valid trigger types: time, spreadsheet, form, calendar, document' },
      };
  }

  const rawResult = await executeRawJs(iife, headUrl, token);

  if (!rawResult.success) {
    return {
      success: false, action: 'create',
      error: rawResult.error,
      hints: rawResult.error?.includes('browser authorization')
        ? { fix: `Visit ${headUrl} in Chrome signed in as script owner, then retry` }
        : { fix: 'Check authentication and deployment URL' },
    };
  }

  let data = rawResult.result as { success?: boolean; triggerId?: string; triggerType?: string; functionName?: string; error?: string };
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* use as-is */ }
  }

  if (!data?.success) {
    const errorMsg = data?.error ?? 'Failed to create trigger';
    const hints: Record<string, string> = { fix: 'Check function name, trigger type, and script permissions' };
    if (errorMsg.includes('maximum') || errorMsg.includes('limit') || errorMsg.includes('20')) {
      hints.fix = 'GAS limits 20 triggers per user per script. Use action=list to review, then delete unused triggers';
    }
    return { success: false, action: 'create', error: errorMsg, hints };
  }

  return {
    success: true, action: 'create',
    triggerId: data.triggerId,
    triggerType: data.triggerType ?? params.triggerType,
    functionName: data.functionName ?? params.functionName,
    hints: {
      next: 'Trigger created. Verify with action=list',
      commonjs: 'Target function must be globally visible. In CommonJS projects: __events__.fnName = handler inside _main() with loadNow: true',
    },
  };
}

async function handleDelete(params: TriggerToolParams, headUrl: string, token: string): Promise<TriggerToolResult> {
  const { triggerId, functionName, deleteAll } = params;

  if (!triggerId && !functionName && !deleteAll) {
    return {
      success: false, action: 'delete',
      error: 'No delete target specified',
      hints: { fix: 'Provide triggerId, functionName, or deleteAll=true. Use action=list with detailed=true to get trigger IDs' },
    };
  }

  if (triggerId && !TRIGGER_ID_PATTERN.test(triggerId)) {
    return {
      success: false, action: 'delete',
      error: 'Invalid triggerId format',
      hints: { fix: 'triggerId must be numeric. Use action=list with detailed=true to get valid trigger IDs' },
    };
  }

  let iife: string;
  if (deleteAll) {
    iife = buildDeleteAllIife();
  } else if (triggerId) {
    iife = buildDeleteByIdIife(triggerId);
  } else {
    iife = buildDeleteByFunctionIife(functionName!);
  }

  // Emit warning for deleteAll
  const extraHints: Record<string, string> = {};
  if (deleteAll) {
    extraHints.warning = 'This will delete ALL project triggers — not just ones created by this tool';
  }

  const rawResult = await executeRawJs(iife, headUrl, token);

  if (!rawResult.success) {
    return {
      success: false, action: 'delete',
      error: rawResult.error,
      hints: rawResult.error?.includes('browser authorization')
        ? { fix: `Visit ${headUrl} in Chrome signed in as script owner, then retry`, ...extraHints }
        : { fix: 'Check authentication and deployment URL', ...extraHints },
    };
  }

  let data = rawResult.result as { success?: boolean; deleted?: number; error?: string };
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* use as-is */ }
  }

  if (!data?.success) {
    return {
      success: false, action: 'delete',
      error: data?.error ?? 'Failed to delete trigger(s)',
      hints: { fix: 'Check trigger ID or function name. Use action=list with detailed=true to verify', ...extraHints },
    };
  }

  return {
    success: true, action: 'delete',
    deleted: data.deleted ?? 0,
    hints: {
      next: `Deleted ${data.deleted ?? 0} trigger(s). Verify with action=list`,
      ...extraHints,
    },
  };
}

// --- Create Validation ---

function validateCreateParams(params: TriggerToolParams): TriggerToolResult | null {
  switch (params.triggerType) {
    case 'time':
      return validateTimeParams(params);
    case 'spreadsheet':
      return validateSpreadsheetParams(params);
    case 'form':
      return validateFormParams(params);
    case 'calendar':
      // calendar only supports onEventUpdated — no additional params needed
      return null;
    case 'document':
      return validateDocumentParams(params);
    default:
      return null;
  }
}

function validateTimeParams(params: TriggerToolParams): TriggerToolResult | null {
  if (!params.interval) {
    return {
      success: false, action: 'create',
      error: 'interval is required for time triggers',
      hints: { fix: 'Specify interval: minutes, hours, days, weeks, monthly, or specific' },
    };
  }

  if (!isValidEnum(params.interval, VALID_INTERVALS)) {
    return {
      success: false, action: 'create',
      error: `Invalid interval: ${params.interval}`,
      hints: { fix: 'Valid intervals: minutes, hours, days, weeks, monthly, specific' },
    };
  }

  if (params.interval === 'minutes') {
    if (params.intervalValue === undefined) {
      return { success: false, action: 'create', error: 'intervalValue is required for minutes', hints: { fix: 'GAS only supports everyMinutes(1, 5, 10, 15, or 30)' } };
    }
    if (!VALID_MINUTES.includes(params.intervalValue)) {
      return { success: false, action: 'create', error: `Invalid minutes value: ${params.intervalValue}`, hints: { fix: 'GAS only supports everyMinutes(1, 5, 10, 15, or 30)' } };
    }
  }

  if (params.interval === 'hours') {
    if (params.intervalValue === undefined) {
      return { success: false, action: 'create', error: 'intervalValue is required for hours', hints: { fix: 'Specify intervalValue: 1-24' } };
    }
    if (!Number.isInteger(params.intervalValue) || params.intervalValue < 1 || params.intervalValue > 24) {
      return { success: false, action: 'create', error: `Invalid hours value: ${params.intervalValue}`, hints: { fix: 'everyHours supports 1-24' } };
    }
  }

  if (params.interval === 'specific' && !params.specificDate) {
    return { success: false, action: 'create', error: 'specificDate is required for one-time triggers', hints: { fix: 'Provide specificDate as ISO date string (e.g. "2025-03-15T10:00:00Z")' } };
  }

  if (params.interval === 'monthly' && params.monthDay === undefined) {
    return { success: false, action: 'create', error: 'monthDay is required for monthly triggers', hints: { fix: 'Provide monthDay (1-31) — e.g. monthDay: 1 for the first of each month. GAS uses onMonthDay() as the frequency specifier for monthly triggers.' } };
  }

  if (params.weekDay && !isValidEnum(params.weekDay, VALID_WEEK_DAYS)) {
    return { success: false, action: 'create', error: `Invalid weekDay: ${params.weekDay}`, hints: { fix: 'Valid weekDays: MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY' } };
  }

  if (params.monthDay !== undefined && (!Number.isInteger(params.monthDay) || params.monthDay < 1 || params.monthDay > 31)) {
    return { success: false, action: 'create', error: `Invalid monthDay: ${params.monthDay}`, hints: { fix: 'monthDay must be 1-31' } };
  }

  if (params.hour !== undefined && (!Number.isInteger(params.hour) || params.hour < 0 || params.hour > 23)) {
    return { success: false, action: 'create', error: `Invalid hour: ${params.hour}`, hints: { fix: 'hour must be 0-23' } };
  }

  if (params.minute !== undefined && (!Number.isInteger(params.minute) || params.minute < 0 || params.minute > 59)) {
    return { success: false, action: 'create', error: `Invalid minute: ${params.minute}`, hints: { fix: 'minute must be 0-59' } };
  }

  return null;
}

function validateSpreadsheetParams(params: TriggerToolParams): TriggerToolResult | null {
  if (!params.spreadsheetEvent) {
    return {
      success: false, action: 'create',
      error: 'spreadsheetEvent is required for spreadsheet triggers',
      hints: { fix: 'Specify spreadsheetEvent: onOpen, onEdit, onChange, onFormSubmit, or onSelectionChange' },
    };
  }
  if (!isValidEnum(params.spreadsheetEvent, VALID_SPREADSHEET_EVENTS)) {
    return {
      success: false, action: 'create',
      error: `Invalid spreadsheetEvent: ${params.spreadsheetEvent}`,
      hints: { fix: 'Valid spreadsheetEvents: onOpen, onEdit, onChange, onFormSubmit, onSelectionChange' },
    };
  }
  return null;
}

function validateFormParams(params: TriggerToolParams): TriggerToolResult | null {
  if (!params.formId) {
    return {
      success: false, action: 'create',
      error: 'formId is required for form triggers',
      hints: { fix: 'Provide the Google Form ID' },
    };
  }
  if (!params.formEvent) {
    return {
      success: false, action: 'create',
      error: 'formEvent is required for form triggers',
      hints: { fix: 'Specify formEvent: onFormSubmit or onFormOpen' },
    };
  }
  if (!isValidEnum(params.formEvent, VALID_FORM_EVENTS)) {
    return {
      success: false, action: 'create',
      error: `Invalid formEvent: ${params.formEvent}`,
      hints: { fix: 'Valid formEvents: onFormSubmit, onFormOpen' },
    };
  }
  return null;
}

function validateDocumentParams(params: TriggerToolParams): TriggerToolResult | null {
  if (!params.documentId) {
    return {
      success: false, action: 'create',
      error: 'documentId is required for document triggers',
      hints: { fix: 'Provide the Google Docs document ID' },
    };
  }
  return null;
}
