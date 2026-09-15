import assert from 'node:assert/strict';
import test from 'node:test';

import { loadRepositoryRiskPolicy } from '../src/v2/repository-risk-policy-loader.mjs';
import { resolveRiskProfile } from '../src/v2/risk-profile.mjs';

test('configured target policy keeps training-system API tests at STANDARD instead of unknown CRITICAL', async () => {
  const repositoryPolicy = await loadRepositoryRiskPolicy('crgasparoto-br/training-system');
  const risk = resolveRiskProfile({
    requested: 'standard',
    changedPaths: ['apps/api/tests/AI_ROUTING_PATCH_PATH_POSTFIX_SMOKE_TEST.md'],
    repositoryPolicy
  });

  assert.equal(risk.profile, 'standard');
  assert.equal(risk.promoted, false);
  assert.ok(risk.reasons.some((reason) => reason.startsWith('repository-standard-root:apps/api/tests:')));
  assert.equal(risk.reasons.some((reason) => reason.startsWith('unknown-path:')), false);
});

test('unknown repositories still fail closed through an empty policy', async () => {
  const repositoryPolicy = await loadRepositoryRiskPolicy('crgasparoto-br/unknown-target');
  const risk = resolveRiskProfile({
    requested: 'standard',
    changedPaths: ['mystery/file.txt'],
    repositoryPolicy
  });

  assert.equal(risk.profile, 'critical');
  assert.equal(risk.promoted, true);
  assert.ok(risk.reasons.includes('unknown-path:mystery/file.txt'));
});
