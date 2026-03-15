/**
 * MCP stdio server for mcp-gas-deploy
 *
 * Registers tools and dispatches incoming tool calls via stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from './auth/sessionManager.js';
import { OAuthClient, loadOAuthConfig } from './auth/oauthClient.js';
import { GASAuthOperations } from './api/gasAuthOperations.js';
import { GASFileOperations } from './api/gasFileOperations.js';
import { handleAuthTool, AUTH_TOOL_DEFINITION } from './tools/authTool.js';
import { handlePullTool, PULL_TOOL_DEFINITION } from './tools/pullTool.js';
import { handleStatusTool, STATUS_TOOL_DEFINITION } from './tools/statusTool.js';
import { handlePushTool, PUSH_TOOL_DEFINITION } from './tools/pushTool.js';
import { handleExecTool, EXEC_TOOL_DEFINITION } from './tools/execTool.js';
import { handleDeployTool, DEPLOY_TOOL_DEFINITION } from './tools/deployTool.js';
import { handleProjectsTool, PROJECTS_TOOL_DEFINITION } from './tools/projectsTool.js';
import { handleProjectCopyTool, PROJECT_COPY_TOOL_DEFINITION } from './tools/projectCopyTool.js';
import { handleLsTool, LS_TOOL_DEFINITION } from './tools/lsTool.js';
import { handleTriggerTool, TRIGGER_TOOL_DEFINITION } from './tools/triggerTool.js';
import { handleCreateTool, CREATE_TOOL_DEFINITION } from './tools/createTool.js';
import { GASDeployOperations } from './api/gasDeployOperations.js';
import { GASProjectOperations } from './api/gasProjectOperations.js';

// Singleton chain — shared across all tool calls to reuse the token cache and avoid re-auth.
// authOps is injected into fileOps, deployOps, and projectOps so all GAS API calls share one session.
const sessionManager = new SessionManager();
const authOps = new GASAuthOperations(sessionManager);
const fileOps = new GASFileOperations(authOps);
const deployOps = new GASDeployOperations(authOps);
const projectOps = new GASProjectOperations(authOps);

// Create MCP server
const server = new Server(
  { name: 'mcp-gas-deploy', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      AUTH_TOOL_DEFINITION,
      CREATE_TOOL_DEFINITION,
      LS_TOOL_DEFINITION,
      PULL_TOOL_DEFINITION,
      STATUS_TOOL_DEFINITION,
      PUSH_TOOL_DEFINITION,
      EXEC_TOOL_DEFINITION,
      DEPLOY_TOOL_DEFINITION,
      PROJECTS_TOOL_DEFINITION,
      PROJECT_COPY_TOOL_DEFINITION,
      TRIGGER_TOOL_DEFINITION,
    ],
  };
});

// Dispatch tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'auth': {
        const config = await loadOAuthConfig();
        if (!config) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'OAuth config not found. Place oauth-config.json in the working directory or ~/.config/mcp-gas/',
              }),
            }],
            isError: true,
          };
        }
        const oauthClient = new OAuthClient(config, sessionManager);
        const result = await handleAuthTool(args as { action: 'login' | 'logout' | 'status' }, oauthClient, sessionManager);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'create': {
        const result = await handleCreateTool(args as unknown as Parameters<typeof handleCreateTool>[0], projectOps, fileOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'ls': {
        const result = await handleLsTool(args as unknown as Parameters<typeof handleLsTool>[0], fileOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'pull': {
        // MCP SDK args is Record<string, unknown> | undefined — cast via unknown
        const result = await handlePullTool(args as unknown as Parameters<typeof handlePullTool>[0], fileOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'status': {
        const result = await handleStatusTool(args as unknown as Parameters<typeof handleStatusTool>[0], fileOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'push': {
        const result = await handlePushTool(args as unknown as Parameters<typeof handlePushTool>[0], fileOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'exec': {
        const result = await handleExecTool(args as unknown as Parameters<typeof handleExecTool>[0], fileOps, sessionManager, deployOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'deploy': {
        const result = await handleDeployTool(args as unknown as Parameters<typeof handleDeployTool>[0], fileOps, deployOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'projects': {
        const result = await handleProjectsTool(args as unknown as Parameters<typeof handleProjectsTool>[0], projectOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'project_copy': {
        const result = await handleProjectCopyTool(args as unknown as Parameters<typeof handleProjectCopyTool>[0], fileOps, projectOps);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'trigger': {
        const result = await handleTriggerTool(
          args as unknown as Parameters<typeof handleTriggerTool>[0],
          sessionManager,
          deployOps,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Tool ${name} threw an unhandled error:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// Graceful shutdown
function shutdown(): void {
  console.error('mcp-gas-deploy: shutting down');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Safety nets — log and exit so the MCP host can detect the failure
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('mcp-gas-deploy: server ready on stdio');
