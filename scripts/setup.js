// @ts-check
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETTINGS = path.join(homedir(), '.claude', 'settings.json');
const SERVER = path.join(ROOT, 'dist', 'server.js');

// 1. Node version check
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`Node >=18 required (got ${process.version})`);
  process.exit(1);
}

// 2. npm install (if needed)
if (!existsSync(path.join(ROOT, 'node_modules'))) {
  console.log('Installing dependencies...');
  execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
}

// 3. Build
console.log('Building...');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

// 4. Verify build output
if (!existsSync(SERVER)) {
  console.error('Build failed — dist/server.js not found');
  process.exit(1);
}

// 5. Register in ~/.claude/settings.json
let settings = {};
if (existsSync(SETTINGS)) {
  const raw = readFileSync(SETTINGS, 'utf8');
  try {
    settings = JSON.parse(raw);
  } catch {
    writeFileSync(SETTINGS + '.bak', raw);
    console.warn('Could not parse settings.json — backed up as settings.json.bak, starting fresh');
  }
}
settings.mcpServers ??= {};
settings.mcpServers.gas = { command: 'node', args: [SERVER], env: { NODE_ENV: 'production' } };
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

// 6. Done
console.log(`\n✓ Registered gas MCP server → ${SERVER}`);
console.log('  Next: restart Claude Code, then run auth({action:"start"}) to authenticate\n');
