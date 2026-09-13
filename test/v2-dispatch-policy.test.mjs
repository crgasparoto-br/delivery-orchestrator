import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { createDispatchDecision } from '../src/v2/dispatch-policy.mjs';

function config(overrides = {}) {
  return {
    requestedRisk: 'auto',
    changedPaths: [],
    repositoryPolicy: { fastSafeRoots: ['apps/web/src/components'] },
    repository: 'owner/repo',
    issueNumber: 63,
    providers: {
      implementer: { provider: 'codex', model: 'auto' },
      auditor: { provider: 'codex', model: 'auto' }
    },
    ...overrides
  };
}

test('auto without concrete paths fails closed without spending CRITICAL AI budget', () => {
  const plan = createDeliveryPlan(config());
  assert.equal(plan.risk.profile, 'critical');
  assert.equal(plan.risk.provisional, true);
  const decision = createDispatchDecision(plan);
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.securityProfile, 'critical');
  assert.equal(decision.discovery.providerCalls, 0);
  assert.deepEqual(decision.materialWorkerBudget, { turns: 0, credits: 0, attempts: 0 });
});

test('concrete FAST scope receives only the FAST material budget', () => {
  const plan = createDeliveryPlan(config({ changedPaths: ['apps/web/src/components/Card.tsx'] }));
  const decision = createDispatchDecision(plan);
  assert.equal(decision.dispatchAllowed, true);
  assert.equal(decision.securityProfile, 'fast');
  assert.deepEqual(decision.materialWorkerBudget, { turns: 20, credits: 100, attempts: 2 });
});

test('unknown concrete path remains CRITICAL and gets CRITICAL budget only after scope exists', () => {
  const plan = createDeliveryPlan(config({ changedPaths: ['unknown/surface.svg'] }));
  const decision = createDispatchDecision(plan);
  assert.equal(decision.dispatchAllowed, true);
  assert.equal(decision.securityProfile, 'critical');
  assert.deepEqual(decision.materialWorkerBudget, { turns: 80, credits: 500, attempts: 3 });
});
