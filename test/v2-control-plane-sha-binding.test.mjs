import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  evaluateReentry,
  resolveCheckedOutControlPlaneHeadSha
} from '../scripts/guard-delivery-v2-reentry.mjs';

const CONTROL_PLANE_A = 'a'.repeat(40);
const EVENT_REF_B = 'b'.repeat(40);

test('workflow event SHA cannot fabricate a control-plane epoch change', () => {
  const currentControllerHeadSha = resolveCheckedOutControlPlaneHeadSha({
    readHead: () => `${CONTROL_PLANE_A}\n`
  });

  assert.equal(currentControllerHeadSha, CONTROL_PLANE_A);
  assert.notEqual(currentControllerHeadSha, EVENT_REF_B);

  const decision = evaluateReentry({
    bootstrapLease: {
      repository: 'owner/repo',
      issueNumber: 63,
      baseBranch: 'main',
      provider: 'codex',
      implementationAttempts: 3,
      status: 'escalated-initial-budget-exhausted',
      effectiveRisk: 'critical',
      failureClass: 'unknown',
      failureStage: 'pre-material',
      workerConclusion: 'failure'
    },
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROL_PLANE_A,
    currentControllerHeadSha
  });

  assert.equal(decision.runController, false);
  assert.equal(decision.status, 'escalated-initial-budget-exhausted');
  assert.equal(decision.nextAction, 'human-escalation');
});

test('recovery propagates the checked-out control-plane SHA instead of GITHUB_SHA', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/delivery-v2-dispatch.yml', import.meta.url),
    'utf8'
  );
  const guard = readFileSync(
    new URL('../scripts/guard-delivery-v2-reentry.mjs', import.meta.url),
    'utf8'
  );
  const reserve = readFileSync(
    new URL('../scripts/reserve-delivery-v2-initial-attempt.mjs', import.meta.url),
    'utf8'
  );

  assert.match(
    workflow,
    /DELIVERY_V2_RECOVERY_CURRENT_CONTROLLER_SHA: \$\{\{ steps\.reentry\.outputs\.recovery_current_controller_sha \}\}/
  );

  assert.match(
    reserve,
    /currentControllerHeadSha: requiredEnv\('DELIVERY_V2_RECOVERY_CURRENT_CONTROLLER_SHA'\)/
  );

  assert.doesNotMatch(
    guard,
    /currentControllerHeadSha:\s*requiredEnv\('GITHUB_SHA'\)/
  );
});

test('invalid checked-out HEAD fails closed', () => {
  assert.throws(
    () => resolveCheckedOutControlPlaneHeadSha({
      readHead: () => 'not-a-git-sha'
    }),
    /checked-out control-plane HEAD must be an exact Git commit SHA/
  );
});
