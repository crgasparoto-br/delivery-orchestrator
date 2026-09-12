import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runDeliveryV2Verification,
  validateDeliveryV2Contract
} from '../scripts/verify-delivery-v2-completeness.mjs';

test('canonical Delivery V2 manifest is structurally valid and complete', () => {
  const result = runDeliveryV2Verification({ rootDir: process.cwd() });

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.total >= 16, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.incompleteRequired, []);
});

test('strict completion mode passes when every required roadmap item is terminal', () => {
  const result = runDeliveryV2Verification({
    rootDir: process.cwd(),
    requireComplete: true
  });

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.complete, true);
  assert.deepEqual(result.incompleteRequired, []);
});

test('validator rejects duplicate IDs and unknown documentation IDs', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'delivery-v2-contract-'));
  mkdirSync(join(rootDir, 'src'), { recursive: true });
  writeFileSync(join(rootDir, 'src', 'implemented.mjs'), 'export default true;\n');

  const manifest = {
    schemaVersion: 1,
    contract: 'delivery-v2',
    umbrellaIssue: 27,
    completionPolicy: {
      terminalStatuses: ['validated', 'rolled-out'],
      allRequiredRequirementsMustBeTerminal: true,
      v1RetirementRequirement: 'DV2-001'
    },
    requirements: [
      {
        id: 'DV2-001',
        status: 'validated',
        requiredForV2Default: true,
        trackingIssue: 27,
        implementationRefs: ['file:src/implemented.mjs'],
        validationRefs: ['github:test#1'],
        rolloutRefs: []
      },
      {
        id: 'DV2-001',
        status: 'planned',
        requiredForV2Default: true,
        trackingIssue: 27,
        implementationRefs: [],
        validationRefs: [],
        rolloutRefs: []
      }
    ]
  };

  const result = validateDeliveryV2Contract({
    manifest,
    rootDir,
    masterSpecText: 'DV2-001 DV2-999',
    roadmapText: 'DV2-001'
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('requirement IDs must be unique'));
  assert.ok(result.errors.includes('DV2-999: master specification contains unknown requirement id'));
});

test('validated local evidence must exist', () => {
  const manifest = {
    schemaVersion: 1,
    contract: 'delivery-v2',
    umbrellaIssue: 27,
    completionPolicy: {
      terminalStatuses: ['validated', 'rolled-out'],
      allRequiredRequirementsMustBeTerminal: true,
      v1RetirementRequirement: 'DV2-001'
    },
    requirements: [
      {
        id: 'DV2-001',
        status: 'validated',
        requiredForV2Default: true,
        trackingIssue: 27,
        implementationRefs: ['file:missing.mjs'],
        validationRefs: ['file:missing.test.mjs'],
        rolloutRefs: []
      }
    ]
  };

  const result = validateDeliveryV2Contract({
    manifest,
    rootDir: process.cwd(),
    masterSpecText: 'DV2-001',
    roadmapText: 'DV2-001'
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('missing local evidence missing.mjs')));
  assert.ok(result.errors.some((error) => error.includes('missing local evidence missing.test.mjs')));
});
