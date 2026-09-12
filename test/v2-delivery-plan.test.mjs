import test from 'node:test';
import assert from 'node:assert/strict';
import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';

test('builds deterministic plan with explicit provider, risk and repository safe root', () => {
  const config = loadV2Config({
    provider: 'claude',
    risk: 'fast',
    changedPaths: ['apps/web/src/components/Filter.tsx'],
    riskPolicyJson: JSON.stringify({ fastSafeRoots: ['apps/web/src/components'] }),
    repository: 'owner/repo',
    issueNumber: '12'
  }, {});
  const plan = createDeliveryPlan(config);
  assert.equal(plan.implementation.provider, 'claude');
  assert.equal(plan.risk.profile, 'fast');
  assert.equal(plan.ci.mode, 'focused');
  assert.equal(plan.controls.noAutomaticMerge, true);
  assert.equal(plan.audit.contractSchemaVersion, 1);
  assert.equal(plan.audit.legacyV1HandoffRequired, false);
  assert.equal(plan.release.contractSchemaVersion, 1);
  assert.equal(plan.release.requiredStatusName, 'Delivery V2 Release');
  assert.equal(plan.release.exactRemoteHeadRequired, true);
  assert.equal(plan.release.createsResultOnlyCommit, false);
  assert.equal(plan.release.automaticMergeAllowed, false);
});

test('unconfigured repository path fails closed in the delivery planner', () => {
  const config = loadV2Config({
    provider: 'claude',
    risk: 'fast',
    changedPaths: ['apps/web/src/components/Filter.tsx']
  }, {});
  const plan = createDeliveryPlan(config);
  assert.equal(plan.risk.profile, 'critical');
  assert.equal(plan.risk.promoted, true);
  assert.equal(plan.ci.mode, 'full');
});

test('provider can differ between implementation and independent audit', () => {
  const config = loadV2Config({ provider: 'copilot', implementerProvider: 'codex', auditorProvider: 'claude', risk: 'critical', changedPaths: ['prisma/migrations/1.sql'] }, {});
  const plan = createDeliveryPlan(config);
  assert.equal(plan.implementation.provider, 'codex');
  assert.equal(plan.audit.provider, 'claude');
  assert.equal(plan.audit.required, true);
  assert.equal(plan.audit.mode, 'independent');
  assert.equal(plan.audit.exactMaterialShaRequired, true);
  assert.equal(plan.audit.independentContextRequired, true);
  assert.equal(plan.audit.legacyV1HandoffRequired, false);
});

test('invalid repository policy fails closed instead of being ignored', () => {
  assert.throws(
    () => loadV2Config({ riskPolicyJson: '{"fastSafeRoot":["docs"]}' }, {}),
    /unsupported repository risk policy field/
  );
});
