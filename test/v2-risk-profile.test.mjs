import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedPaths, resolveRiskProfile } from '../src/v2/risk-profile.mjs';
import { normalizeRepositoryRiskPolicy } from '../src/v2/repository-risk-policy.mjs';
import { executionPolicyFor } from '../src/v2/execution-policy.mjs';

const WEB_POLICY = Object.freeze({
  fastSafeRoots: ['apps/web/src/components', 'docs'],
  standardRoots: ['apps/web/src', 'apps/api/src'],
  criticalPaths: [
    'apps/web/src/routes/Gate.tsx'
  ]
});

test('presentation-only component change is fast only inside an explicit safe root', () => {
  assert.equal(
    classifyChangedPaths(['apps/web/src/components/Card.tsx'], { repositoryPolicy: WEB_POLICY }).profile,
    'fast'
  );
});

test('same presentation extension outside a trusted root fails closed', () => {
  const result = classifyChangedPaths(['infra/diagram.svg'], { repositoryPolicy: WEB_POLICY });
  assert.equal(result.profile, 'critical');
  assert.match(result.reasons[0], /^unknown-path:/);
});

test('application source is standard only inside an explicit repository standard root', () => {
  assert.equal(
    classifyChangedPaths(['apps/api/src/routes/cards.ts'], { repositoryPolicy: WEB_POLICY }).profile,
    'standard'
  );
});

test('migration promotes to critical before repository allowlists', () => {
  const result = classifyChangedPaths(
    ['apps/api/prisma/migrations/001/migration.sql'],
    { repositoryPolicy: { fastSafeRoots: ['apps/api'] } }
  );
  assert.equal(result.profile, 'critical');
  assert.match(result.reasons[0], /^core-critical-path:/);
});

test('unknown path fails closed as critical', () => {
  const result = classifyChangedPaths(['custom/runtime.magic'], { repositoryPolicy: WEB_POLICY });
  assert.equal(result.profile, 'critical');
  assert.match(result.reasons[0], /^unknown-path:/);
});

test('missing changed-file evidence fails closed as provisional critical', () => {
  const result = classifyChangedPaths([], { repositoryPolicy: WEB_POLICY });
  assert.equal(result.profile, 'critical');
  assert.equal(result.provisional, true);
  assert.deepEqual(result.reasons, ['no-changed-paths-fail-closed']);
});

test('explicit fast is promoted when observed path is critical', () => {
  const result = resolveRiskProfile({
    requested: 'fast',
    changedPaths: ['.github/workflows/ci.yml'],
    repositoryPolicy: WEB_POLICY
  });
  assert.equal(result.profile, 'critical');
  assert.equal(result.promoted, true);
});

test('explicit fast cannot bypass missing changed-file evidence', () => {
  const result = resolveRiskProfile({ requested: 'fast', changedPaths: [], repositoryPolicy: WEB_POLICY });
  assert.equal(result.profile, 'critical');
  assert.equal(result.provisional, true);
  assert.equal(result.promoted, true);
});

test('requested risk may promote a repository-safe path but never downgrade it', () => {
  const promoted = resolveRiskProfile({
    requested: 'standard',
    changedPaths: ['apps/web/src/components/Card.tsx'],
    repositoryPolicy: WEB_POLICY
  });
  assert.equal(promoted.profile, 'standard');
  assert.equal(promoted.promoted, false);

  const blockedDowngrade = resolveRiskProfile({
    requested: 'fast',
    changedPaths: ['apps/web/src/routes/Gate.tsx'],
    repositoryPolicy: WEB_POLICY
  });
  assert.equal(blockedDowngrade.profile, 'critical');
  assert.equal(blockedDowngrade.promoted, true);
});

test('training-system audit entrypoints stay critical even inside a broad safe root', () => {
  const repositoryPolicy = {
    fastSafeRoots: ['apps/web/src'],
    criticalPaths: [
      'apps/web/src/routes/ProtectedRoute.tsx',
      'apps/web/src/pages/Login.tsx',
      'apps/web/src/stores/useAuthStore.ts'
    ]
  };

  for (const path of repositoryPolicy.criticalPaths) {
    const result = classifyChangedPaths([path], { repositoryPolicy });
    assert.equal(result.profile, 'critical', path);
  }
});

test('core sensitive entrypoint names cannot be weakened by a broad fast root', () => {
  for (const path of [
    'apps/web/src/routes/ProtectedRoute.tsx',
    'apps/web/src/pages/Login.tsx',
    'apps/web/src/stores/useAuthStore.ts'
  ]) {
    const result = classifyChangedPaths([path], {
      repositoryPolicy: { fastSafeRoots: ['apps/web/src'] }
    });
    assert.equal(result.profile, 'critical', path);
    assert.match(result.reasons[0], /^core-sensitive-boundary:/);
  }
});

test('repository critical roots win over overlapping fast safe roots', () => {
  const result = classifyChangedPaths(['apps/web/src/access/Gate.tsx'], {
    repositoryPolicy: {
      fastSafeRoots: ['apps/web/src'],
      criticalRoots: ['apps/web/src/access']
    }
  });
  assert.equal(result.profile, 'critical');
  assert.match(result.reasons[0], /^repository-critical-root:/);
});

test('repository policy rejects typo fields instead of silently weakening classification', () => {
  assert.throws(
    () => normalizeRepositoryRiskPolicy({ fastSafeRoot: ['apps/web/src/components'] }),
    /unsupported repository risk policy field/
  );
});

test('repository policy rejects traversal and glob ambiguity', () => {
  assert.throws(
    () => normalizeRepositoryRiskPolicy({ fastSafeRoots: ['../apps/web'] }),
    /stay inside the repository/
  );
  assert.throws(
    () => normalizeRepositoryRiskPolicy({ criticalPaths: ['apps/**/auth.ts'] }),
    /glob syntax is not supported/
  );
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
