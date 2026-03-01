/**
 * Unit tests for deployConfig
 *
 * Tests readDeployConfig, writeDeployConfig, getDeploymentInfo, setDeploymentInfo
 * using real temp directories — no external dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readDeployConfig,
  writeDeployConfig,
  getDeploymentInfo,
  setDeploymentInfo,
} from '../../src/config/deployConfig.js';

describe('deployConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- readDeployConfig ---

  describe('readDeployConfig', () => {
    it('returns empty object when gas-deploy.json does not exist', async () => {
      const config = await readDeployConfig(tmpDir);
      assert.deepEqual(config, {});
    });

    it('parses an existing config file', async () => {
      const data = { scriptId1: { stagingUrl: 'https://example.com' } };
      await fs.writeFile(
        path.join(tmpDir, 'gas-deploy.json'),
        JSON.stringify(data),
        'utf-8'
      );

      const config = await readDeployConfig(tmpDir);
      assert.deepEqual(config, data);
    });

    it('throws on malformed JSON', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'gas-deploy.json'),
        'not valid json',
        'utf-8'
      );
      await assert.rejects(() => readDeployConfig(tmpDir), SyntaxError);
    });
  });

  // --- writeDeployConfig ---

  describe('writeDeployConfig', () => {
    it('writes formatted JSON to gas-deploy.json', async () => {
      const config = { abc123: { stagingUrl: 'https://staging.example.com' } };
      await writeDeployConfig(tmpDir, config);

      const raw = await fs.readFile(path.join(tmpDir, 'gas-deploy.json'), 'utf-8');
      assert.deepEqual(JSON.parse(raw), config);
      assert.ok(raw.includes('\n'), 'output should be pretty-printed');
    });

    it('does not leave a .tmp file after successful write', async () => {
      await writeDeployConfig(tmpDir, {});
      const files = await fs.readdir(tmpDir);
      assert.ok(files.every(f => !f.endsWith('.tmp')), `unexpected .tmp file(s) left: ${files.filter(f => f.endsWith('.tmp')).join(', ')}`);
    });

    it('round-trips: write then read returns the same config', async () => {
      const config = {
        scriptA: { stagingUrl: 'https://a.example.com', stagingVersionNumber: 3 },
        scriptB: { prodUrl: 'https://b.example.com', headUrl: 'https://b.example.com/dev' },
      };
      await writeDeployConfig(tmpDir, config);
      const result = await readDeployConfig(tmpDir);
      assert.deepEqual(result, config);
    });

    it('round-trips: timestamp and consumer config fields survive write/read', async () => {
      // Use runtime timestamps — any valid ISO string should round-trip unchanged
      const now = Date.now();
      const stagingTs = new Date(now - 6 * 60 * 60 * 1000).toISOString();  // 6h ago
      const prodTs    = new Date(now - 72 * 60 * 60 * 1000).toISOString(); // 72h ago

      const config = {
        scriptId123: {
          stagingDeploymentId: 'AKfycbStaging',
          stagingVersionNumber: 5,
          stagingUrl: 'https://script.google.com/macros/s/staging/exec',
          stagingDeployedAt: stagingTs,
          prodDeploymentId: 'AKfycbProd',
          prodVersionNumber: 5,
          prodUrl: 'https://script.google.com/macros/s/prod/exec',
          prodDeployedAt: prodTs,
          userSymbol: 'SheetsChat',
          stagingConsumerScriptId: 'consumerStagingScriptId',
          stagingConsumerDeploymentId: 'AKfycbConsumerStaging',
          prodConsumerScriptId: 'consumerProdScriptId',
          prodConsumerDeploymentId: 'AKfycbConsumerProd',
        },
      };
      await writeDeployConfig(tmpDir, config);
      const result = await readDeployConfig(tmpDir);
      assert.deepEqual(result, config);
    });
  });

  // --- getDeploymentInfo ---

  describe('getDeploymentInfo', () => {
    it('returns empty object for an unknown scriptId', async () => {
      const info = await getDeploymentInfo(tmpDir, 'unknownScript');
      assert.deepEqual(info, {});
    });

    it('returns stored info for a known scriptId', async () => {
      const config = { scriptX: { stagingUrl: 'https://staging.x.com', stagingVersionNumber: 2 } };
      await writeDeployConfig(tmpDir, config);

      const info = await getDeploymentInfo(tmpDir, 'scriptX');
      assert.deepEqual(info, config.scriptX);
    });

    it('returns stagingDeployedAt and prodDeployedAt when present', async () => {
      // Use runtime timestamps — any valid ISO string should survive the write/read cycle
      const now = Date.now();
      const stagingTs = new Date(now - 2 * 60 * 60 * 1000).toISOString();  // 2h ago
      const prodTs    = new Date(now - 72 * 60 * 60 * 1000).toISOString(); // 72h ago

      const config = {
        scriptY: {
          stagingDeployedAt: stagingTs,
          prodDeployedAt: prodTs,
          stagingVersionNumber: 3,
          prodVersionNumber: 2,
        },
      };
      await writeDeployConfig(tmpDir, config);

      const info = await getDeploymentInfo(tmpDir, 'scriptY');
      assert.equal(info.stagingDeployedAt, stagingTs);
      assert.equal(info.prodDeployedAt, prodTs);
    });

    it('returns consumer config fields when present', async () => {
      const config = {
        scriptZ: {
          userSymbol: 'MyLib',
          stagingConsumerScriptId: 'stagingConsumerId',
          prodConsumerScriptId: 'prodConsumerId',
        },
      };
      await writeDeployConfig(tmpDir, config);

      const info = await getDeploymentInfo(tmpDir, 'scriptZ');
      assert.equal(info.userSymbol, 'MyLib');
      assert.equal(info.stagingConsumerScriptId, 'stagingConsumerId');
      assert.equal(info.prodConsumerScriptId, 'prodConsumerId');
    });
  });

  // --- setDeploymentInfo ---

  describe('setDeploymentInfo', () => {
    it('creates a new entry when the scriptId has no existing record', async () => {
      await setDeploymentInfo(tmpDir, 'newScript', { stagingUrl: 'https://new.example.com' });
      const config = await readDeployConfig(tmpDir);
      assert.equal(config['newScript']?.stagingUrl, 'https://new.example.com');
    });

    it('merges partial info with an existing entry', async () => {
      await setDeploymentInfo(tmpDir, 'script1', { stagingUrl: 'https://staging.example.com' });
      await setDeploymentInfo(tmpDir, 'script1', { prodUrl: 'https://prod.example.com' });

      const info = await getDeploymentInfo(tmpDir, 'script1');
      assert.equal(info.stagingUrl, 'https://staging.example.com');
      assert.equal(info.prodUrl, 'https://prod.example.com');
    });

    it('overwrites specific fields while preserving others', async () => {
      await setDeploymentInfo(tmpDir, 'script1', {
        stagingUrl: 'https://old.example.com',
        stagingVersionNumber: 1,
      });
      await setDeploymentInfo(tmpDir, 'script1', { stagingVersionNumber: 2 });

      const info = await getDeploymentInfo(tmpDir, 'script1');
      assert.equal(info.stagingUrl, 'https://old.example.com');
      assert.equal(info.stagingVersionNumber, 2);
    });

    it('does not affect other scriptIds', async () => {
      await setDeploymentInfo(tmpDir, 'scriptA', { stagingUrl: 'https://a.example.com' });
      await setDeploymentInfo(tmpDir, 'scriptB', { prodUrl: 'https://b.example.com' });

      const infoA = await getDeploymentInfo(tmpDir, 'scriptA');
      const infoB = await getDeploymentInfo(tmpDir, 'scriptB');
      assert.equal(infoA.stagingUrl, 'https://a.example.com');
      assert.ok(!infoA.prodUrl);
      assert.equal(infoB.prodUrl, 'https://b.example.com');
      assert.ok(!infoB.stagingUrl);
    });
  });
});
