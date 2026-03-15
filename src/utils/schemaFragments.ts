/**
 * Reusable schema property definitions to spread into MCP tool inputSchemas.
 *
 * Usage:
 *   properties: { ...SchemaFragments.scriptId, ...SchemaFragments.localDir, ... }
 */

export class SchemaFragments {
  static readonly scriptId = {
    scriptId: {
      type: 'string' as const,
      description: 'Google Apps Script project ID',
      pattern: '^[A-Za-z0-9_-]{20,}$',
    },
  };

  static readonly localDir = {
    localDir: {
      type: 'string' as const,
      description: 'Local directory for .gs files (default: ~/gas-projects/<scriptId>)',
    },
  };

  static readonly dryRun = {
    dryRun: {
      type: 'boolean' as const,
      description: 'Preview changes without applying them',
      default: false,
    },
  };

  /** Build an action enum property with the given allowed values. */
  static action<T extends string>(
    values: readonly T[],
    description: string,
    defaultValue?: T
  ): { action: { type: 'string'; enum: readonly T[]; description: string; default?: T } } {
    return {
      action: {
        type: 'string' as const,
        enum: values,
        description,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      },
    };
  }
}
