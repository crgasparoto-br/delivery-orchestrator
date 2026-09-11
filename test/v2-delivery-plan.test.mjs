import test from 'node:test';
import assert from 'node:assert/strict';
import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';

test('builds deterministic plan with explicit provider and risk', () => {
  const config = loadV2Config({ provider: 'claude', risk: 'fast', changedPaths: ['apps/web/src/components/Filter.tsx'], repository: 'owner/repo', issueNumber: '12' }, {});
  const plan = createDeliveryPlan(config);
  assert.equal(plan.implementation.provider, 'claude');
  assert.equal(plan.risk.profile, 'fast');
  assert.equal(plan.ci.mode, 'focused');
  assert.equal(plan.controls.noAutomaticMerge, true);
});

test('provider can differ between implementation and independent audit', () => {
  const config = loadV2Config({ provider: 'copilot', implementerProvider: 'codex', auditorProvider: 'claude', risk: 'critical', changedPaths: ['prisma/migrations/1.sql'] }, {});
  const plan = createDeliveryPlan(config);
  assert.equal(plan.implementation.provider, 'codex');
  assert.equal(plan.audit.provider, 'claude');
  assert.equal(plan.audit.required, true);
});
