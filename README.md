# mcp-gas-deploy

Local-first MCP server for Google Apps Script deployment with CommonJS validation.

Manage the full GAS lifecycle — file sync, CommonJS validation, versioned deployments with circular buffer slots, remote execution, and project discovery — all from your MCP client.

**Requires:** Node.js >= 18

## Prerequisites

- **Node.js** >= 18
- **Google Cloud project** with the [Apps Script API](https://console.cloud.google.com/apis/api/script.googleapis.com) enabled
- **OAuth 2.0 credentials** — create a Desktop App credential in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and download the JSON

### Required OAuth Scopes

The server requests these scopes automatically during login:

- `script.projects` — read/write project files
- `script.deployments` — manage deployments
- `script.webapp.deploy` — deploy web apps
- `drive.file` — access script-bound files
- `drive.readonly` — list/search standalone GAS projects
- `userinfo.email`, `userinfo.profile` — identify the authenticated user

## Setup

1. **Install and build:**

   ```bash
   git clone <repo-url> && cd mcp-gas-deploy
   npm install
   npm run build
   ```

2. **Place OAuth credentials** as `oauth-config.json` in one of:

   - The working directory (project root)
   - `~/.config/mcp-gas/oauth-config.json`

3. **Configure your MCP client.** For Claude Code, add to `.claude/settings.json`:

   ```json
   {
     "mcpServers": {
       "mcp-gas-deploy": {
         "command": "node",
         "args": ["/absolute/path/to/mcp-gas-deploy/dist/server.js"]
       }
     }
   }
   ```

4. **Authenticate** by calling the `auth` tool with `action: "login"`. This opens a browser for Google OAuth consent.

## MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `auth` | OAuth login / logout / status | `action` |
| `pull` | Download GAS project files to local directory | `scriptId`, `targetDir?` |
| `status` | Compare local vs remote by content hash | `scriptId`, `localDir?` |
| `push` | Push local files to GAS with CommonJS validation | `scriptId`, `prune?`, `skipValidation?` |
| `exec` | Execute a GAS function (auto-pushes first) | `scriptId`, `function`, `module?`, `args?` |
| `deploy` | Deploy / rollback / promote / list-versions | `scriptId`, `action` |
| `projects` | List or search standalone GAS projects | `action`, `query?` |
| `project_copy` | Copy a GAS project to a new standalone project | `scriptId`, `title?` |

## Typical Workflow

1. `auth login` — authenticate with Google
2. `projects list` — find your script ID
3. `pull` — download project files locally
4. Edit `.gs` files in your editor
5. `push` — sync back to GAS (validates CommonJS structure)
6. `exec` — run a function remotely
7. `deploy action=deploy` — create a versioned staging deployment
8. `deploy action=promote` — promote staging to production

## Architecture

```
src/
├── auth/          OAuth 2.0 PKCE + token persistence (~/.auth/mcp-gas/tokens/)
├── api/           GAS API wrappers (file, deploy, project, auth operations)
├── sync/rsync.ts  Push/pull/status engine with git archive for remote-only files
├── tools/         MCP tool handlers (one per tool)
├── config/        gas-deploy.json read/write (DeploymentInfo type)
└── validation/    CommonJS module structure validator
```

## Deployment Model

Deployments use a **4-slot circular buffer** per environment (staging and production):

- **`deploy`** creates a new version, writes it to the next available slot, and points the staging deployment at that slot.
- **`rollback`** steps back one slot (no wrap-around). Works for both `staging` and `prod`.
- **`promote`** copies the current staging version to a production slot.
- **`list-versions`** shows all version snapshots with descriptions.

All deployment state is tracked in `gas-deploy.json`, which is written only after the GAS API call succeeds.

## Testing

```bash
npm test            # all tests
npm run test:unit   # unit tests only
```

See [`test/e2e/README.md`](test/e2e/README.md) for the full round-trip end-to-end test plan.
