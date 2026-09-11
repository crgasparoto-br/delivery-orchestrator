import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedPaths, resolveRiskProfile } from '../src/v2/risk-profile.mjs';
import { executionPolicyFor } from '../src/v2/execution-policy.mjs';

test('presentation-only component change is fast', () => {
  assert.equal(classifyChangedPaths(['apps/web/src/components/Card.tsx']).profile, 'fast');
});

test('application source defaults to standard', () => {
  assert.equal(classifyChangedPaths(['apps/api/src/routes/cards.ts']).profile, 'standard');
});

test('migration promotes to critical', () => {
  assert.equal(classifyChangedPaths(['apps/api/prisma/migrations/001/migration.sql']).profile, 'critical');
});

test('unknown path fails closed as critical', () => {
  const result = classifyChangedPaths(['custom/runtime.magic']);
  assert.equal(result.profile, 'critical');
  assert.match(result.reasons[0], /^unknown-path:/);
});

test('explicit fast is promoted when observed path is critical', () => {
  const result = resolveRiskProfile({ requested: 'fast', changedPaths: ['.github/workflows/ci.yml'] });
  assert.equal(result.profile, 'critical');
  assert.equal(result.promoted, true);
});

test('explicit fast is provisional before paths are known', () => {
  const result = resolveRiskProfile({ requested: 'fast', changedPaths: [] });
  assert.equal(result.profile, 'fast');
  assert.equal(result.provisional, true);
});

test('fast policy limits retries and skips mandatory LLM audit', () => {
  const policy = executionPolicyFor('fast');
  assert.equal(policy.maxImplementationAttempts, 2);
  assert.equal(policy.auditRequired, false);
  assert.equal(policy.ciMode, 'focused');
});

test('critical policy keeps full PR regression and independent audit', () => {
  const policy = executionPolicyFor('critical');
  assert.equal(policy.fullRegressionOnPr, true);
  assert.equal(policy.auditMode, 'independent');
});
