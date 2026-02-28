/**
 * Shared type definitions for Google Apps Script API
 *
 * Contains all interface and type definitions used across GAS API modules.
 */

/**
 * Google Apps Script project information
 */
export interface GASProject {
  scriptId: string;
  title: string;
  parentId?: string;
  createTime?: string;
  updateTime?: string;
}

/**
 * Google Apps Script file information
 */
export interface GASFile {
  name: string;
  type: 'SERVER_JS' | 'HTML' | 'JSON';
  source?: string;
  position?: number;
  createTime?: string;
  updateTime?: string;
  lastModifyUser?: {
    name?: string;
    email?: string;
  };
  functionSet?: {
    values: Array<{
      name: string;
    }>;
  };
}

/**
 * Google Apps Script deployment information
 */
export interface GASDeployment {
  deploymentId: string;
  versionNumber: number;
  description?: string;
  manifestFileName?: string;
  updateTime?: string;
  webAppUrl?: string;
  deploymentConfig?: {
    scriptId: string;
    description: string;
    manifestFileName: string;
    versionNumber: number;
  };
  entryPoints?: EntryPoint[];
}

/**
 * Deployment entry point types
 */
export type EntryPointType = 'WEB_APP' | 'EXECUTION_API' | 'ADD_ON';

/**
 * Web App access levels
 */
export type WebAppAccess = 'MYSELF' | 'DOMAIN' | 'ANYONE' | 'ANYONE_ANONYMOUS';

/**
 * Web App execution context
 */
export type WebAppExecuteAs = 'USER_ACCESSING' | 'USER_DEPLOYING';

/**
 * Web App configuration
 */
export interface WebAppConfig {
  access: WebAppAccess;
  executeAs: WebAppExecuteAs;
}

/**
 * Web App entry point
 */
export interface WebAppEntryPoint {
  url?: string;
  entryPointConfig: WebAppConfig;
}

/**
 * API Executable entry point
 */
export interface ExecutionApiEntryPoint {
  entryPointConfig: {
    access: WebAppAccess;
  };
}

/**
 * Deployment entry point
 */
export interface EntryPoint {
  entryPointType: EntryPointType;
  webApp?: WebAppEntryPoint;
  executionApi?: ExecutionApiEntryPoint;
}

/**
 * Deployment configuration options
 */
export interface DeploymentOptions {
  entryPointType?: EntryPointType;
  webAppConfig?: WebAppConfig;
  accessLevel?: WebAppAccess;
}

/**
 * Version information returned by createVersion
 */
export interface GASVersion {
  scriptId: string;
  versionNumber: number;
  description?: string;
  createTime?: string;
}
