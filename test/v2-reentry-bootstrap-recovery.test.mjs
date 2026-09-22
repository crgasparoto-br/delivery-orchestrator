import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReentry, selectManagedPullRequest } from '../scripts/guard-delivery-v2-reentry.mjs';
import {
  bootstrapLeaseForDecision,
  resolveRecoveryForReservation
} from '../scripts/reserve-delivery-v2-initial-attempt.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function managedPr(overrides = {}) {
  return {
    number: 122, state: 'open', author_association: 'OWNER',
    title: '[delivery-v2] recover issue 105',
    body: 'Closes #105',
    user: { login: 'crgasparoto-br' },
    base: { ref: 'main', sha: BASE, repo: { full_name: 'crgasparoto-br/delivery-orchestrator' } },
    head: { ref: 'delivery-v2/issue-105', sha: HEAD, repo: { full_name: 'crgasparoto-br/delivery-orchestrator' } },
    ...overrides
  };
}

function bootstrapLease(overrides = {}) {
  return {
    schemaVersion: 1,
    commentId: 105001,
    repository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: null,
    requestedRisk: 'auto',
    effectiveRisk: 'critical',
    implementationAttempts: 3,
    status: 'reserved-initial-attempt',
    controllerRunId: 35117753934,
    workerRunId: null,
    workerWorkflow: 'delivery-v2-worker-codex-critical.lock.yml',
    dispatchNonce: 'nonce-105',
    ...overrides
  };
}

function successfulWorker(overrides = {}) {
  return { id: 35117775004, status: 'completed', conclusion: 'success', ...overrides };
}


test('successful bootstrap worker without PR is rearmed after a verified control-plane change without charging another attempt', () => {
  const previousControllerHeadSha = 'c'.repeat(40);
  const currentControllerHeadSha = 'd'.repeat(40);

  const decision = evaluateReentry({
    pullRequest: null,
    stateEnvelope: null,
    bootstrapLease: bootstrapLease({
      implementationAttempts: 1,
      controllerHeadSha: previousControllerHeadSha
    }),
    targetRepository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    recoveredWorkerRun: successfulWorker(),
    bootstrapControllerHeadSha: previousControllerHeadSha,
    currentControllerHeadSha
  });

  assert.equal(decision.runController, true);
  assert.equal(decision.resumePr, null);
  assert.equal(decision.recoverWorkerRunId, null);
  assert.equal(decision.status, 'retry-initial-delivery');
  assert.equal(decision.nextAction, 'retry-initial-worker');

  // A tentativa anterior foi perdida por defeito do control plane.
  // Reserve initial implementation attempt incrementara novamente para 1,
  // em vez de consumir a tentativa 2.
  assert.equal(decision.priorInitialAttempts, 0);
  assert.equal(decision.attempts.implementation, 1);

  assert.equal(
    decision.recovery.reason,
    'control-plane-changed-after-successful-pre-material-worker-without-pr'
  );
  assert.equal(
    decision.recovery.previousControllerHeadSha,
    previousControllerHeadSha
  );
  assert.equal(
    decision.recovery.currentControllerHeadSha,
    currentControllerHeadSha
  );

  const reservationRecovery = resolveRecoveryForReservation({
    persistedBootstrapLease: bootstrapLease({
      implementationAttempts: 1,
      controllerHeadSha: previousControllerHeadSha
    }),
    currentControllerHeadSha,
    priorImplementationAttempts: decision.priorInitialAttempts,
    envRecovery: decision.recovery,
    recoveredWorkerRun: successfulWorker()
  });

  assert.equal(
    reservationRecovery.reason,
    'control-plane-changed-after-successful-pre-material-worker-without-pr'
  );

  const rearmedLease = bootstrapLeaseForDecision({
    decision: {
      dispatchAllowed: true,
      securityProfile: 'critical'
    },
    repository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    requestedRisk: 'auto',
    runId: 35117753935,
    priorImplementationAttempts: decision.priorInitialAttempts,
    workerWorkflow: 'delivery-v2-worker-codex-critical.lock.yml',
    dispatchNonce: 'nonce-rearmed-105',
    controllerHeadSha: currentControllerHeadSha,
    recovery: reservationRecovery
  });

  assert.equal(rearmedLease.status, 'reserved-initial-attempt');
  assert.equal(rearmedLease.implementationAttempts, 1);
  assert.equal(
    rearmedLease.recovery.previousImplementationAttempts,
    1
  );
  assert.equal(
    rearmedLease.recovery.currentControllerHeadSha,
    currentControllerHeadSha
  );
});

test('successful bootstrap worker without PR is still recovered when control plane did not change', () => {
  const controllerHeadSha = 'c'.repeat(40);

  const decision = evaluateReentry({
    pullRequest: null,
    stateEnvelope: null,
    bootstrapLease: bootstrapLease({
      implementationAttempts: 1,
      controllerHeadSha
    }),
    targetRepository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    recoveredWorkerRun: successfulWorker(),
    bootstrapControllerHeadSha: controllerHeadSha,
    currentControllerHeadSha: controllerHeadSha
  });

  assert.equal(decision.runController, true);
  assert.equal(decision.status, 'resume-initial-delivery');
  assert.equal(decision.nextAction, 'recover-initial-attempt');
  assert.equal(decision.recoverWorkerRunId, 35117775004);
  assert.equal(decision.priorInitialAttempts, 1);

  assert.equal(
    resolveRecoveryForReservation({
      persistedBootstrapLease: bootstrapLease({
        implementationAttempts: 1,
        controllerHeadSha
      }),
      currentControllerHeadSha: controllerHeadSha,
      priorImplementationAttempts: 0,
      recoveredWorkerRun: successfulWorker()
    }),
    null
  );
});

test('reservation does not trust recovery outputs when the correlated worker did not succeed', () => {
  const previousControllerHeadSha = 'c'.repeat(40);
  const currentControllerHeadSha = 'd'.repeat(40);

  assert.throws(
    () => resolveRecoveryForReservation({
      persistedBootstrapLease: bootstrapLease({
        implementationAttempts: 1,
        controllerHeadSha: previousControllerHeadSha
      }),
      currentControllerHeadSha,
      priorImplementationAttempts: 0,
      envRecovery: {
        reason:
          'control-plane-changed-after-successful-pre-material-worker-without-pr',
        previousImplementationAttempts: 1,
        previousControllerHeadSha,
        currentControllerHeadSha,
        grantedImplementationAttempts: 1
      },
      recoveredWorkerRun: {
        id: 35117775004,
        status: 'completed',
        conclusion: 'failure'
      }
    }),
    /trusted successful bootstrap recovery is not eligible/
  );
});

test('managed PR without persistent state recovers the correlated successful model-less bootstrap worker without reserving a new attempt', () => {
  const decision = evaluateReentry({
    pullRequest: managedPr(),
    stateEnvelope: null,
    bootstrapLease: bootstrapLease(),
    targetRepository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    recoveredWorkerRun: successfulWorker()
  });

  assert.equal(decision.runController, true);
  assert.equal(decision.resumePr, null);
  assert.equal(decision.recoverWorkerRunId, 35117775004);
  assert.equal(decision.pullRequestNumber, 122);
  assert.equal(decision.materialHeadSha, HEAD);
  assert.equal(decision.status, 'resume-initial-delivery');
  assert.equal(decision.nextAction, 'recover-initial-attempt');
  assert.equal(decision.priorInitialAttempts, 3);
  assert.equal(decision.attempts.implementation, 3);
});

test('PR without canonical state or successful worker is adopted without claiming V2 production or resetting budgets', () => {
  const decision = evaluateReentry({
    pullRequest: managedPr(),
    stateEnvelope: null,
    bootstrapLease: bootstrapLease(),
    targetRepository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    recoveredWorkerRun: successfulWorker({ conclusion: 'failure' })
  });

  assert.equal(decision.runController, true);
  assert.equal(decision.status, 'legacy-adopted');
  assert.equal(decision.nextAction, 'post-write-refreeze');
  assert.equal(decision.attempts.implementation, 3);
  assert.equal(decision.adoption.auditEvidence, null);
  assert.equal(decision.adoption.adoption.source, 'github-open-pull-request');
});

test('bootstrap PR recovery rejects an explicitly persisted model mismatch instead of adopting it', () => {
  assert.throws(() => evaluateReentry({
    pullRequest: managedPr(),
    stateEnvelope: null,
    bootstrapLease: bootstrapLease({ model: 'wrong-model' }),
    targetRepository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 105,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    recoveredWorkerRun: successfulWorker()
  }), /model does not match resolved delivery policy/);
});

test('managed PR selection blocks a linked fork instead of falling through to a new delivery', () => {
  assert.throws(() => selectManagedPullRequest([
    managedPr({ head: { ref: 'delivery-v2/issue-105', sha: HEAD, repo: { full_name: 'someone/fork' } } })
  ], {
    issueNumber: 105,
    baseBranch: 'main',
    trustedLogin: 'crgasparoto-br',
    repository: 'crgasparoto-br/delivery-orchestrator'
  }), /repository mismatch or fork/);
});
