/**
 * Unit tests for bootstrapConfig — load/save round-trip, search order, missing file.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sinon from 'sinon';
import { loadBootstrapConfig, saveBootstrapConfig } from '../../src/auth/bootstrapConfig.js';

const TEST_BASE = path.join(os.homedir(), '.cache', 'mcp-gas-deploy-test');

describe('bootstrapConfig', () => {
  let tmpDir: string;
  let cwdStub: sinon.SinonStub;

  beforeEach(async () => {
    await fs.mkdir(TEST_BASE, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(TEST_BASE, 'bootstrap-config-'));
    cwdStub = sinon.stub(process, 'cwd').returns(tmpDir);
  });

  afterEach(async () => {
    cwdStub.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadBootstrapConfig', () => {
    it('returns null when no config file exists', async () => {
      const result = await loadBootstrapConfig();
      assert.equal(result, null);
    });

    it('returns config from <cwd>/.mcp-gas/bootstrap-config.json', async () => {
      const configDir = path.join(tmpDir, '.mcp-gas');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'bootstrap-config.json'),
        JSON.stringify({ tokenBrokerUrl: 'https://script.google.com/macros/s/test123/exec' })
      );

      const result = await loadBootstrapConfig();
      assert.ok(result);
      assert.equal(result.tokenBrokerUrl, 'https://script.google.com/macros/s/test123/exec');
    });

    it('returns null when file exists but has no tokenBrokerUrl', async () => {
      const configDir = path.join(tmpDir, '.mcp-gas');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'bootstrap-config.json'),
        JSON.stringify({ other: 'value' })
      );

      const result = await loadBootstrapConfig();
      assert.equal(result, null);
    });

    it('returns null when file contains invalid JSON', async () => {
      const configDir = path.join(tmpDir, '.mcp-gas');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'bootstrap-config.json'),
        'not-valid-json'
      );

      const result = await loadBootstrapConfig();
      assert.equal(result, null);
    });
  });

  describe('saveBootstrapConfig', () => {
    it('saves URL and can be loaded back', async () => {
      const url = 'https://script.google.com/macros/s/abc123/exec';
      await saveBootstrapConfig(tmpDir, url);

      const result = await loadBootstrapConfig();
      assert.ok(result);
      assert.equal(result.tokenBrokerUrl, url);
    });

    it('creates .mcp-gas directory if absent', async () => {
      const url = 'https://script.google.com/macros/s/xyz/exec';
      await saveBootstrapConfig(tmpDir, url);

      const stat = await fs.stat(path.join(tmpDir, '.mcp-gas'));
      assert.ok(stat.isDirectory());
    });

    it('writes to <cwd>/.mcp-gas/bootstrap-config.json', async () => {
      const url = 'https://script.google.com/macros/s/test/exec';
      await saveBootstrapConfig(tmpDir, url);

      const content = await fs.readFile(
        path.join(tmpDir, '.mcp-gas', 'bootstrap-config.json'),
        'utf-8'
      );
      const parsed = JSON.parse(content) as { tokenBrokerUrl: string };
      assert.equal(parsed.tokenBrokerUrl, url);
    });

    it('overwrites existing config with new URL', async () => {
      await saveBootstrapConfig(tmpDir, 'https://script.google.com/macros/s/old/exec');
      await saveBootstrapConfig(tmpDir, 'https://script.google.com/macros/s/new/exec');

      const result = await loadBootstrapConfig();
      assert.ok(result);
      assert.equal(result.tokenBrokerUrl, 'https://script.google.com/macros/s/new/exec');
    });

    it('does not leave temp file on success', async () => {
      await saveBootstrapConfig(tmpDir, 'https://script.google.com/macros/s/test/exec');

      const configDir = path.join(tmpDir, '.mcp-gas');
      const files = await fs.readdir(configDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      assert.equal(tmpFiles.length, 0, 'No .tmp files should remain after successful save');
    });
  });
});
