/**
 * Shared constants for the library-based promote deployment model.
 * Pure constants — no dependencies.
 */

export type LibraryEnvironment = 'staging' | 'prod';

/** ConfigManager property keys used to store env config in the DEV project */
export const LIB_CONFIG_KEYS = {
  staging: {
    sourceScriptId: 'STAGING_SOURCE_SCRIPT_ID',
    scriptId: 'STAGING_SCRIPT_ID',
    spreadsheetUrl: 'STAGING_SPREADSHEET_URL',
    promotedAt: 'STAGING_PROMOTED_AT',
  },
  prod: {
    sourceScriptId: 'PROD_SOURCE_SCRIPT_ID',
    scriptId: 'PROD_SCRIPT_ID',
    spreadsheetUrl: 'PROD_SPREADSHEET_URL',
    promotedAt: 'PROD_PROMOTED_AT',
  },
} as const;

/** Infrastructure keys excluded from property sync */
export const MANAGED_PROPERTY_KEYS = new Set([
  'STAGING_SOURCE_SCRIPT_ID', 'PROD_SOURCE_SCRIPT_ID',
  'STAGING_SCRIPT_ID', 'PROD_SCRIPT_ID',
  'STAGING_SPREADSHEET_URL', 'PROD_SPREADSHEET_URL',
  'STAGING_PROMOTED_AT', 'PROD_PROMOTED_AT',
  'DEV_URL', 'STAGING_URL', 'PROD_URL',
  'DEV_DEPLOYMENT_ID', 'STAGING_DEPLOYMENT_ID', 'PROD_DEPLOYMENT_ID',
  'TEMPLATE_SCRIPT_ID', 'USER_SYMBOL',
]);

/** Regex for spreadsheet ID validation before interpolation into GAS code */
export const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{25,60}$/;
