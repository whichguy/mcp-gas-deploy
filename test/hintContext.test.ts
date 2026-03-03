import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { buildHintContext } from '../src/utils/hintContext.js';
import type { DeploymentInfo } from '../src/config/deployConfig.js';

describe('buildHintContext', () => {
  it('returns fallback message when deployInfo is undefined', () => {
    const result = buildHintContext(undefined);
    assert.ok(result.includes('not found or empty'), `got: ${result}`);
  });

  it('returns staging-only context when env="staging"', () => {
    const info: DeploymentInfo = {
      stagingVersionNumber: 3,
      stagingDeploymentId: 'AKf-staging',
      stagingSlotIds: ['s1', 's2'],
      stagingActiveSlotIndex: 1,
    };
    const result = buildHintContext(info, 'staging');
    assert.ok(result.includes('staging: v3'), `got: ${result}`);
    assert.ok(result.includes('deployId=AKf-staging'), `got: ${result}`);
    assert.ok(result.includes('slots=2'), `got: ${result}`);
    assert.ok(result.includes('activeSlot=1'), `got: ${result}`);
    assert.ok(!result.includes('prod:'), `should not include prod, got: ${result}`);
  });

  it('returns prod-only context when env="prod"', () => {
    const info: DeploymentInfo = {
      prodVersionNumber: 5,
      prodDeploymentId: 'AKf-prod',
      prodSlotIds: ['p1', 'p2', 'p3', 'p4'],
      prodActiveSlotIndex: 2,
    };
    const result = buildHintContext(info, 'prod');
    assert.ok(result.includes('prod: v5'), `got: ${result}`);
    assert.ok(result.includes('deployId=AKf-prod'), `got: ${result}`);
    assert.ok(result.includes('slots=4'), `got: ${result}`);
    assert.ok(result.includes('activeSlot=2'), `got: ${result}`);
    assert.ok(!result.includes('staging:'), `should not include staging, got: ${result}`);
  });

  it('returns both environments when env is omitted', () => {
    const info: DeploymentInfo = {
      stagingVersionNumber: 3,
      stagingDeploymentId: 'AKf-staging',
      stagingSlotIds: ['s1'],
      stagingActiveSlotIndex: 0,
      prodVersionNumber: 2,
      prodDeploymentId: 'AKf-prod',
      prodSlotIds: ['p1'],
      prodActiveSlotIndex: 0,
    };
    const result = buildHintContext(info);
    assert.ok(result.includes('staging:'), `got: ${result}`);
    assert.ok(result.includes('prod:'), `got: ${result}`);
    assert.ok(result.includes(' | '), `should separate with pipe, got: ${result}`);
  });

  it('shows "none" for missing fields', () => {
    const info: DeploymentInfo = {};
    const result = buildHintContext(info, 'staging');
    assert.ok(result.includes('vnone'), `got: ${result}`);
    assert.ok(result.includes('deployId=none'), `got: ${result}`);
    assert.ok(result.includes('slots=0'), `got: ${result}`);
    assert.ok(result.includes('activeSlot=none'), `got: ${result}`);
  });

  it('includes consumer info when userSymbol is set', () => {
    const info: DeploymentInfo = {
      userSymbol: 'SheetsChat',
    };
    const result = buildHintContext(info);
    assert.ok(result.includes('consumer: userSymbol=SheetsChat'), `got: ${result}`);
  });

  it('omits consumer info when userSymbol is not set', () => {
    const info: DeploymentInfo = {
      stagingVersionNumber: 1,
    };
    const result = buildHintContext(info);
    assert.ok(!result.includes('consumer:'), `should not include consumer, got: ${result}`);
  });
});
