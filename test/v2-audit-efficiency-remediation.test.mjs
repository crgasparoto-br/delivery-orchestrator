import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { resolveOperationalAuditPolicy } from '../src/v2/audit-policy.mjs';
import { applyOperationalEvent, createOperationalDelivery } from '../src/v2/operational-controller.mjs';

const SHA = 'a'.repeat(40);

function planConfig(risk, standardAuditRequired) {
  return {
    requestedRisk: risk,
    changedPaths: risk === 'critical' ? ['.github/workflows/example.yml'] : ['apps/web/src/example.ts'],
    repositoryPolicy: { standardRoots: ['apps/web/src'] },
    repository: 'owner/repo',
    issueNumber: 63,
    standardAuditRequired,
    providers: {
      implementer: { provider: 'codex', model: 'auto' },
      auditor: { provider: 'codex', model: 'auto' }
    }
  };
}

test('STANDARD audit policy suppresses the LLM audit when repository policy disables it', () => {
  const policy = resolveOperationalAuditPolicy({ riskProfile: 'standard', repository: 'owner/repo', standardAuditRequired: false });
  assert.deepEqual(policy, { required: false, mode: 'none', maxAttempts: 0 });

  const plan = createDeliveryPlan(planConfig('standard', false));
  assert.equal(plan.risk.profile, 'standard');
  assert.equal(plan.audit.required, false);
  assert.equal(plan.audit.mode, 'none');
  assert.equal(plan.audit.maxAttempts, 0);

  let state = createOperationalDelivery({ plan, materialHeadSha: SHA });
  assert.equal(state.auditRequired, false);
  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: SHA, conclusion: 'success', evidenceRef: 'run:green' } });
  assert.equal(state.status, 'ready-for-human-merge');
  assert.equal(state.auditAttempts, 0);
});

test('CRITICAL audit cannot be disabled by the STANDARD repository switch', () => {
  const policy = resolveOperationalAuditPolicy({ riskProfile: 'critical', repository: 'owner/repo', standardAuditRequired: false });
  assert.equal(policy.required, true);
  assert.equal(policy.mode, 'independent');

  const plan = createDeliveryPlan(planConfig('critical', false));
  assert.equal(plan.audit.required, true);
  assert.equal(plan.audit.mode, 'independent');
});

test('platform CI executes one strict completeness scan and one target scan', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const ci = await readFile(new URL('../.github/workflows/delivery-v2-ci.yml', import.meta.url), 'utf8');

  assert.equal(pkg.scripts['verify:v2'], 'npm run verify:v2:complete && npm run verify:v2:targets');
  assert.equal(pkg.scripts['verify:v2:complete'], 'node scripts/verify-delivery-v2-completeness.mjs --require-complete');
  assert.equal(pkg.scripts['verify:v2:targets'], 'node scripts/verify-delivery-v2-targets.mjs');
  assert.equal((ci.match(/run: npm run verify:v2\s*(?:\n|$)/g) ?? []).length, 1);
  assert.doesNotMatch(ci, /run: npm run verify:v2:complete/);
});
