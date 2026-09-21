import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  checkedOutControlPlaneHeadShaFromJobLog,
  evaluateReentry,
  recoveryContextForExhaustedBootstrap,
  resolveBootstrapControllerHeadShaFromRun,
  resolveCheckedOutControlPlaneHeadSha,
  terminalBootstrapLease
} from '../scripts/guard-delivery-v2-reentry.mjs';
import {
  shouldRearmFailedTechnicalHygiene
} from '../scripts/resume-delivery-v2-controller.mjs';
import {
  bootstrapLeaseForDecision,
  resolveRecoveryForReservation
} from '../scripts/reserve-delivery-v2-initial-attempt.mjs';

const CONTROL_PLANE_A = 'a'.repeat(40);
const EVENT_REF_B = 'b'.repeat(40);
const CONTROL_PLANE_B = 'c'.repeat(40);
const CONTROL_PLANE_C = 'd'.repeat(40);


test('technical hygiene recovery uses checked-out control-plane HEAD instead of workflow event SHA', () => {
  const failedWorkerControllerSha = CONTROL_PLANE_A;

  // Deliberately different from the checkout. The workflow event SHA is not
  // authoritative for the control-plane epoch.
  const workflowEventSha = CONTROL_PLANE_B;

  const checkedOutControllerSha =
    resolveCheckedOutControlPlaneHeadSha({
      readHead: () => `${failedWorkerControllerSha}\n`
    });

  assert.notEqual(workflowEventSha, checkedOutControllerSha);

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'technical-hygiene-worker-failed',
      runConclusion: 'failure',
      runHeadSha: failedWorkerControllerSha,
      currentControllerSha: checkedOutControllerSha
    }),
    false,
    'a different workflow event SHA must not fabricate a control-plane epoch change'
  );

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'technical-hygiene-worker-failed',
      runConclusion: 'failure',
      runHeadSha: failedWorkerControllerSha,
      currentControllerSha: CONTROL_PLANE_C
    }),
    true,
    'a genuinely different checked-out control-plane HEAD may rearm the failed hygiene worker'
  );
});

test('resume technical hygiene recovery resolves the checked-out control-plane HEAD', () => {
  const source = readFileSync(
    new URL('../scripts/resume-delivery-v2-controller.mjs', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /const currentControllerSha\s*=\s*resolveCheckedOutControlPlaneHeadSha\(\);/
  );

  assert.doesNotMatch(
    source,
    /process\.env\.GITHUB_SHA/
  );
});

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
    /currentControllerHeadSha:\s*requiredEnv\(\s*'DELIVERY_V2_RECOVERY_CURRENT_CONTROLLER_SHA'\s*\)/
  );

  assert.match(
    reserve,
    /resolveRecoveryForReservation\(\{/
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

test('legacy exhausted bootstrap without controllerHeadSha recovers the exact checked-out SHA from controller job logs', async () => {
  const legacyLease = {
    repository: 'owner/repo',
    issueNumber: 615,
    baseBranch: 'main',
    provider: 'codex',
    implementationAttempts: 3,
    status: 'escalated-initial-budget-exhausted',
    effectiveRisk: 'standard',
    controllerRunId: 35356774626,
    failureClass: 'unknown',
    failureStage: 'pre-material',
    workerConclusion: 'failure'
  };

  const controllerRun = {
    id: 35356774626,
    repository: {
      full_name: 'crgasparoto-br/delivery-orchestrator'
    },
    event: 'workflow_dispatch',
    path: '.github/workflows/delivery-v2-dispatch.yml',
    head_branch: 'main',

    // Deliberately not authoritative. The checkout log below is.
    head_sha: EVENT_REF_B
  };

  const jobLog = [
    '2026-09-18T14:31:44.3230756Z ##[group]Checking out the ref',
    '2026-09-18T14:31:44.3493326Z [command]/usr/bin/git log -1 --format=%H',
    `2026-09-18T14:31:44.3522836Z ${CONTROL_PLANE_A}`
  ].join('\n');

  const previousControllerHeadSha =
    await resolveBootstrapControllerHeadShaFromRun({
      bootstrapLease: legacyLease,
      controllerRun,
      orchestratorRepository:
        'crgasparoto-br/delivery-orchestrator',
      trustedRef: 'main',
      actionsToken: 'test-token',
      listJobs: async () => [{
        id: 105637947578,
        name: 'Bounded deterministic delivery'
      }],
      readJobLog: async () => jobLog
    });

  assert.equal(
    previousControllerHeadSha,
    CONTROL_PLANE_A
  );

  assert.notEqual(
    previousControllerHeadSha,
    controllerRun.head_sha
  );

  const decision = evaluateReentry({
    bootstrapLease: legacyLease,
    targetRepository: 'owner/repo',
    issueNumber: 615,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha:
      previousControllerHeadSha,
    currentControllerHeadSha: CONTROL_PLANE_B
  });

  assert.equal(decision.runController, true);
  assert.equal(decision.nextAction, 'retry-initial-worker');

  const recovery = resolveRecoveryForReservation({
    persistedBootstrapLease: legacyLease,
    currentControllerHeadSha: CONTROL_PLANE_B,
    priorImplementationAttempts: 2,
    envRecovery: null,
    bootstrapControllerHeadSha:
      previousControllerHeadSha
  });

  assert.deepEqual(recovery, {
    reason: 'control-plane-changed-after-pre-material-exhaustion',
    previousImplementationAttempts: 3,
    previousControllerHeadSha: CONTROL_PLANE_A,
    currentControllerHeadSha: CONTROL_PLANE_B,
    grantedImplementationAttempts: 1
  });
});

test('legacy checkout provenance fails closed when controller logs are ambiguous', () => {
  const log = [
    '[command]/usr/bin/git log -1 --format=%H',
    CONTROL_PLANE_A,
    '[command]/usr/bin/git log -1 --format=%H',
    CONTROL_PLANE_B
  ].join('\n');

  assert.throws(
    () => checkedOutControlPlaneHeadShaFromJobLog(log),
    /exactly one checked-out control-plane SHA/
  );
});

test('reserve reconstructs recovery provenance when older workflow YAML omits recovery env', () => {
  const exhaustedLease = {
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    implementationAttempts: 3,
    status: 'escalated-initial-budget-exhausted',
    effectiveRisk: 'critical',
    failureClass: 'infrastructure',
    failureStage: 'pre-material',
    workerConclusion: 'timed_out',
    controllerHeadSha: CONTROL_PLANE_A
  };

  const recovery = resolveRecoveryForReservation({
    persistedBootstrapLease: exhaustedLease,
    currentControllerHeadSha: CONTROL_PLANE_B,
    priorImplementationAttempts: 2,
    envRecovery: null
  });

  assert.deepEqual(recovery, {
    reason: 'control-plane-changed-after-pre-material-exhaustion',
    previousImplementationAttempts: 3,
    previousControllerHeadSha: CONTROL_PLANE_A,
    currentControllerHeadSha: CONTROL_PLANE_B,
    grantedImplementationAttempts: 1
  });

  const lease = bootstrapLeaseForDecision({
    decision: {
      dispatchAllowed: true,
      securityProfile: 'critical'
    },
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    requestedRisk: 'critical',
    runId: 202,
    priorImplementationAttempts: 2,
    workerWorkflow: 'worker.yml',
    dispatchNonce: 'legacy-workflow-recovery',
    controllerHeadSha: CONTROL_PLANE_B,
    recovery
  });

  assert.equal(lease.implementationAttempts, 3);
  assert.equal(lease.controllerHeadSha, CONTROL_PLANE_B);
  assert.deepEqual(lease.recovery, recovery);
});

test('reserve rejects recovery env that disagrees with trusted persisted provenance', () => {
  const exhaustedLease = {
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    implementationAttempts: 3,
    status: 'escalated-initial-budget-exhausted',
    effectiveRisk: 'critical',
    failureClass: 'unknown',
    failureStage: 'pre-material',
    workerConclusion: 'failure',
    controllerHeadSha: CONTROL_PLANE_A
  };

  assert.throws(
    () => resolveRecoveryForReservation({
      persistedBootstrapLease: exhaustedLease,
      currentControllerHeadSha: CONTROL_PLANE_B,
      priorImplementationAttempts: 2,
      envRecovery: {
        reason: 'control-plane-changed-after-pre-material-exhaustion',
        previousImplementationAttempts: 3,
        previousControllerHeadSha: CONTROL_PLANE_A,
        currentControllerHeadSha: CONTROL_PLANE_C
      }
    }),
    /recovery environment does not match trusted bootstrap provenance/
  );
});

test('reserve fails closed when exhausted bootstrap is not eligible for the current epoch', () => {
  const exhaustedLease = {
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    implementationAttempts: 3,
    status: 'escalated-initial-budget-exhausted',
    effectiveRisk: 'critical',
    failureClass: 'infrastructure',
    failureStage: 'pre-material',
    workerConclusion: 'timed_out',
    controllerHeadSha: CONTROL_PLANE_A
  };

  assert.equal(
    recoveryContextForExhaustedBootstrap({
      bootstrapLease: exhaustedLease,
      currentControllerHeadSha: CONTROL_PLANE_A
    }),
    null
  );

  assert.throws(
    () => resolveRecoveryForReservation({
      persistedBootstrapLease: exhaustedLease,
      currentControllerHeadSha: CONTROL_PLANE_A,
      priorImplementationAttempts: 2,
      envRecovery: null
    }),
    /trusted exhausted bootstrap lease is not eligible for recovery/
  );
});

test('recovery is one-shot for the same checked-out control-plane epoch after a failed recovered worker', () => {
  const exhaustedLease = {
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    implementationAttempts: 3,
    status: 'escalated-initial-budget-exhausted',
    effectiveRisk: 'critical',
    failureClass: 'infrastructure',
    failureStage: 'pre-material',
    workerConclusion: 'timed_out',
    controllerHeadSha: CONTROL_PLANE_A
  };

  const rearm = evaluateReentry({
    bootstrapLease: exhaustedLease,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROL_PLANE_A,
    currentControllerHeadSha: CONTROL_PLANE_B
  });

  assert.equal(rearm.runController, true);
  assert.equal(rearm.nextAction, 'retry-initial-worker');
  assert.equal(rearm.priorInitialAttempts, 2);
  assert.equal(rearm.recovery.previousImplementationAttempts, 3);
  assert.equal(rearm.recovery.previousControllerHeadSha, CONTROL_PLANE_A);
  assert.equal(rearm.recovery.currentControllerHeadSha, CONTROL_PLANE_B);
  assert.equal(rearm.recovery.grantedImplementationAttempts, 1);

  const recoveredLease = bootstrapLeaseForDecision({
    decision: { dispatchAllowed: true, securityProfile: 'critical' },
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    requestedRisk: 'critical',
    runId: 202,
    priorImplementationAttempts: rearm.priorInitialAttempts,
    workerWorkflow: 'worker.yml',
    dispatchNonce: 'recovery-nonce',
    recovery: rearm.recovery
  });

  assert.equal(recoveredLease.implementationAttempts, 3);
  assert.equal(recoveredLease.status, 'reserved-initial-attempt');
  assert.deepEqual(recoveredLease.recovery, rearm.recovery);

  const failedWorker = {
    id: 303,
    status: 'completed',
    conclusion: 'failure'
  };

  const failedDecision = evaluateReentry({
    bootstrapLease: recoveredLease,
    recoveredWorkerRun: failedWorker,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROL_PLANE_B,
    currentControllerHeadSha: CONTROL_PLANE_B
  });

  assert.equal(failedDecision.runController, false);
  assert.equal(failedDecision.status, 'escalated-initial-budget-exhausted');
  assert.equal(failedDecision.nextAction, 'human-escalation');

  const terminalLease = terminalBootstrapLease(
    recoveredLease,
    failedDecision,
    failedWorker
  );

  assert.equal(terminalLease.failureStage, 'pre-material');
  assert.equal(terminalLease.failureClass, 'unknown');
  assert.equal(terminalLease.workerConclusion, 'failure');
  assert.equal(
    terminalLease.recovery.currentControllerHeadSha,
    CONTROL_PLANE_B
  );

  const sameEpoch = evaluateReentry({
    bootstrapLease: terminalLease,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROL_PLANE_B,
    currentControllerHeadSha: CONTROL_PLANE_B
  });

  assert.equal(sameEpoch.runController, false);
  assert.equal(sameEpoch.nextAction, 'human-escalation');

  const nextEpoch = evaluateReentry({
    bootstrapLease: terminalLease,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROL_PLANE_B,
    currentControllerHeadSha: CONTROL_PLANE_C
  });

  assert.equal(nextEpoch.runController, true);
  assert.equal(nextEpoch.nextAction, 'retry-initial-worker');
  assert.equal(
    nextEpoch.recovery.previousControllerHeadSha,
    CONTROL_PLANE_B
  );
  assert.equal(
    nextEpoch.recovery.currentControllerHeadSha,
    CONTROL_PLANE_C
  );
});


test('terminal exhaustion cannot be reopened by increasing the runtime attempt ceiling', () => {
  const previous = process.env.DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS;
  process.env.DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS = '4';

  try {
    const decision = evaluateReentry({
      bootstrapLease: {
        repository: 'owner/repo',
        issueNumber: 63,
        baseBranch: 'main',
        provider: 'codex',
        implementationAttempts: 3,
        status: 'escalated-initial-budget-exhausted',
        effectiveRisk: 'critical',
        failureClass: 'infrastructure',
        failureStage: 'pre-material',
        workerConclusion: 'timed_out',
        controllerHeadSha: CONTROL_PLANE_A
      },
      targetRepository: 'owner/repo',
      issueNumber: 63,
      baseBranch: 'main',
      provider: 'codex',
      currentControllerHeadSha: CONTROL_PLANE_A
    });

    assert.equal(decision.runController, false);
    assert.equal(
      decision.status,
      'escalated-initial-budget-exhausted'
    );
    assert.equal(decision.nextAction, 'human-escalation');
  } finally {
    if (previous == null) {
      delete process.env.DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS;
    } else {
      process.env.DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS = previous;
    }
  }
});

test('recovery binds the previous epoch to the persisted checked-out SHA, not workflow run head_sha', () => {
  const lease = bootstrapLeaseForDecision({
    decision: {
      dispatchAllowed: true,
      securityProfile: 'critical'
    },
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    requestedRisk: 'critical',
    runId: 202,
    priorImplementationAttempts: 2,
    workerWorkflow: 'worker.yml',
    dispatchNonce: 'checkout-bound-nonce',
    controllerHeadSha: CONTROL_PLANE_B
  });

  assert.equal(lease.implementationAttempts, 3);
  assert.equal(lease.controllerHeadSha, CONTROL_PLANE_B);

  const terminalLease = {
    ...lease,
    status: 'escalated-initial-budget-exhausted',
    failureClass: 'infrastructure',
    failureStage: 'pre-material',
    workerConclusion: 'timed_out'
  };

  const sameCheckedOutEpoch = evaluateReentry({
    bootstrapLease: terminalLease,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',

    // Deliberately stale/different workflow metadata. It must not
    // manufacture a control-plane epoch transition.
    bootstrapControllerHeadSha: CONTROL_PLANE_A,
    currentControllerHeadSha: CONTROL_PLANE_B
  });

  assert.equal(sameCheckedOutEpoch.runController, false);
  assert.equal(sameCheckedOutEpoch.nextAction, 'human-escalation');

  const nextCheckedOutEpoch = evaluateReentry({
    bootstrapLease: terminalLease,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROL_PLANE_A,
    currentControllerHeadSha: CONTROL_PLANE_C
  });

  assert.equal(nextCheckedOutEpoch.runController, true);
  assert.equal(nextCheckedOutEpoch.nextAction, 'retry-initial-worker');
  assert.equal(
    nextCheckedOutEpoch.recovery.previousControllerHeadSha,
    CONTROL_PLANE_B
  );
  assert.equal(
    nextCheckedOutEpoch.recovery.currentControllerHeadSha,
    CONTROL_PLANE_C
  );
  assert.equal(nextCheckedOutEpoch.priorInitialAttempts, 2);
});

test('canonical documentation defines bounded pre-material recovery without weakening the normal attempt ceiling', () => {
  const master = readFileSync(
    new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url),
    'utf8'
  );
  const operations = readFileSync(
    new URL('../docs/delivery-v2.md', import.meta.url),
    'utf8'
  );
  const security = readFileSync(
    new URL('../docs/SECURITY.md', import.meta.url),
    'utf8'
  );
  const readme = readFileSync(
    new URL('../README.md', import.meta.url),
    'utf8'
  );

  assert.match(master, /### 8\.1 Pre-material control-plane recovery/);
  assert.match(master, /exactly one recovery dispatch for a control-plane epoch/);
  assert.match(master, /cannot authorize a fourth material implementation attempt/);
  assert.match(master, /same control-plane SHA cannot grant a second recovery/i);
  assert.match(
    master,
    /reservation step independently re-derives recovery eligibility/
  );

  assert.match(operations, /exactly one recovery dispatch per verified control-plane SHA epoch/);
  assert.match(operations, /same control-plane SHA remains `human-escalation`/);

  assert.match(security, /AI execution[\s\S]*cannot grant itself additional attempts/);
  assert.match(security, /controller-owned pre-material recovery/);
  assert.match(security, /cannot repeat on the same control-plane SHA/);

  assert.match(readme, /exactly one recovery dispatch may be granted after a verified change/);
  assert.match(readme, /configured implementation ceiling is not increased/);
});
