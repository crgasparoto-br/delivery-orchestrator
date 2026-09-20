import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersistentDeliveryState } from '../src/v2/persistent-state.mjs';
import {
  evaluateReentry,
  parseBootstrapLease,
  parsePersistentStateEnvelope,
  selectManagedPullRequest
} from '../scripts/guard-delivery-v2-reentry.mjs';
import { bootstrapLeaseForDecision } from '../scripts/reserve-delivery-v2-initial-attempt.mjs';
import { controllerMetadataForNewMaterial, markExistingAuditInFlight, rebuildCiPendingState, shouldStartFreshAudit } from '../scripts/resume-delivery-v2-controller.mjs';
import { ciFailureClassForEvidence } from '../src/v2/controller-runtime.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { operationalStateFromPersistent } from '../src/v2/operational-controller.mjs';
import { validateControllerRunProvenance } from '../src/v2/controller-provenance.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const CONTROLLER_OLD = 'd'.repeat(40);
const CONTROLLER_NEW = 'e'.repeat(40);

function pr(overrides = {}) {
  return {
    number: 77,
    title: '[delivery-v2] fix issue 63',
    state: 'open', user: { login: 'owner' }, author_association: 'OWNER',
    body: 'Closes #63',
    ...overrides,
    base: { ref: 'main', sha: BASE, ...overrides.base, repo: { full_name: 'owner/repo' } },
    head: { ref: 'delivery/63', sha: HEAD_A, ...overrides.head, repo: { full_name: 'owner/repo' } }
  };
}

function persistent(overrides = {}) {
  return createPersistentDeliveryState({
    repository: 'owner/repo',
    issueNumber: 63,
    pullRequestNumber: 77,
    baseRef: 'main',
    baseSha: BASE,
    headRef: 'delivery/63',
    materialHeadSha: HEAD_A,
    effectiveRisk: 'critical',
    classifier: { subjectSha: HEAD_A, version: 'v1', fingerprint: 'fp' },
    provider: 'codex',
    status: 'ci-pending',
    attempts: { implementation: 1, audit: 0, auditRemediation: 0 },
    workflowChecks: [],
    blockingFindings: [],
    evidenceRefs: [],
    ...overrides
  });
}

function envelope(state = persistent()) {
  return { persistent: state, controller: { nextAction: 'observe-ci' } };
}

function planFor(risk = 'critical') {
  return createDeliveryPlan({
    requestedRisk: risk,
    changedPaths: ['src/v2/example.mjs'],
    repositoryPolicy: {},
    repository: 'owner/repo',
    issueNumber: 63,
    providers: {
      implementer: { provider: 'codex', model: 'auto' },
      auditor: { provider: 'codex', model: 'auto' }
    }
  });
}

test('no managed PR and no prior bootstrap lease allows one initial controller path without pre-counting a provider call', () => {
  const selected = selectManagedPullRequest([], { issueNumber: 63, baseBranch: 'main', repository: 'owner/repo', trustedLogin: 'owner' });
  assert.equal(selected, null);
  const decision = evaluateReentry({
    pullRequest: selected,
    stateEnvelope: null,
    bootstrapLease: null,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.resumePr, null);
  assert.equal(decision.nextAction, 'dispatch-initial-worker');
  assert.equal(decision.attempts.implementation, 0);
});

test('initial attempt is reserved only when deterministic dispatch has authorized material AI work', () => {
  const blocked = bootstrapLeaseForDecision({
    decision: { dispatchAllowed: false, securityProfile: 'critical' },
    repository: 'owner/repo', issueNumber: 63, baseBranch: 'main', provider: 'codex', requestedRisk: 'auto', runId: 100
  });
  assert.equal(blocked, null);

  const lease = bootstrapLeaseForDecision({
    decision: { dispatchAllowed: true, securityProfile: 'critical' },
    repository: 'owner/repo', issueNumber: 63, baseBranch: 'main', provider: 'codex', requestedRisk: 'critical', runId: 101, workerWorkflow: 'worker.yml', dispatchNonce: 'nonce-1'
  });
  assert.equal(lease.implementationAttempts, 1);
  assert.equal(lease.workerWorkflow, 'worker.yml');
  assert.equal(lease.dispatchNonce, 'nonce-1');
  assert.equal(lease.controllerRunId, 101);
  assert.equal(lease.status, 'reserved-initial-attempt');

  const recoveredLease = bootstrapLeaseForDecision({
    decision: { dispatchAllowed: true, securityProfile: 'critical' },
    repository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    requestedRisk: 'critical',
    runId: 102,
    priorImplementationAttempts: 2,
    workerWorkflow: 'worker.yml',
    dispatchNonce: 'nonce-recovery',
    recovery: {
      reason: 'control-plane-changed-after-pre-material-exhaustion',
      previousImplementationAttempts: 3,
      previousControllerHeadSha: CONTROLLER_OLD,
      currentControllerHeadSha: CONTROLLER_NEW
    }
  });
  assert.equal(recoveredLease.implementationAttempts, 3);
  assert.deepEqual(recoveredLease.recovery, {
    reason: 'control-plane-changed-after-pre-material-exhaustion',
    previousImplementationAttempts: 3,
    previousControllerHeadSha: CONTROLLER_OLD,
    currentControllerHeadSha: CONTROLLER_NEW,
    grantedImplementationAttempts: 1
  });
});

test('existing managed PR resumes persisted state through the controller instead of starting another initial worker', () => {
  const selected = selectManagedPullRequest([pr()], { issueNumber: 63, baseBranch: 'main', repository: 'owner/repo', trustedLogin: 'owner' });
  const decision = evaluateReentry({
    pullRequest: selected,
    stateEnvelope: envelope(),
    bootstrapLease: null,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.resumePr, 77);
  assert.equal(decision.status, 'resume-existing-delivery');
  assert.equal(decision.nextAction, 'observe-ci');
  assert.equal(decision.staleStateDetected, false);
  assert.equal(decision.attempts.implementation, 1);
});

test('head drift resumes deterministic classification without resetting attempt counters', () => {
  const decision = evaluateReentry({
    pullRequest: pr({ head: { ref: 'delivery/63', sha: HEAD_B } }),
    stateEnvelope: envelope(),
    bootstrapLease: null,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.resumePr, 77);
  assert.equal(decision.staleStateDetected, true);
  assert.equal(decision.materialHeadSha, HEAD_B);
  assert.equal(decision.nextAction, 'classify');
  assert.equal(decision.attempts.implementation, 1);
});

test('existing PR without canonical state is adopted with unknown budgets instead of resetting them', () => {
  const decision = evaluateReentry({
    pullRequest: pr(),
    stateEnvelope: null,
    bootstrapLease: null,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.pullRequestNumber, 77);
  assert.equal(decision.status, 'legacy-adopted');
  assert.equal(decision.nextAction, 'post-write-refreeze');
  assert.deepEqual(decision.attempts, { implementation: null, audit: null, auditRemediation: null });
});

test('a failed pre-PR bootstrap attempt retries within the existing bounded budget instead of resetting it', () => {
  const decision = evaluateReentry({
    pullRequest: null,
    stateEnvelope: null,
    bootstrapLease: {
      repository: 'owner/repo', issueNumber: 63, baseBranch: 'main', provider: 'codex',
      implementationAttempts: 1, status: 'reserved-initial-attempt', effectiveRisk: 'critical'
    },
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.status, 'retry-initial-delivery');
  assert.equal(decision.nextAction, 'retry-initial-worker');
  assert.equal(decision.priorInitialAttempts, 1);
  assert.equal(decision.attempts.implementation, 1);
});


test('exhausted pre-material bootstrap grants exactly one recovery attempt after the control plane changes', () => {
  const decision = evaluateReentry({
    pullRequest: null,
    stateEnvelope: null,
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
      workerConclusion: 'failure',
      controllerHeadSha: CONTROLLER_OLD
    },
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROLLER_OLD,
    currentControllerHeadSha: CONTROLLER_NEW
  });

  assert.equal(decision.runController, true);
  assert.equal(decision.status, 'retry-initial-delivery');
  assert.equal(decision.nextAction, 'retry-initial-worker');
  assert.equal(decision.priorInitialAttempts, 2);
  assert.equal(decision.attempts.implementation, 3);
  assert.deepEqual(decision.recovery, {
    reason: 'control-plane-changed-after-pre-material-exhaustion',
    previousImplementationAttempts: 3,
    previousControllerHeadSha: CONTROLLER_OLD,
    currentControllerHeadSha: CONTROLLER_NEW,
    grantedImplementationAttempts: 1
  });
});

test('exhausted bootstrap remains blocked without a new control-plane epoch or for a non pre-material failure', () => {
  const bootstrapLease = {
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
    controllerHeadSha: CONTROLLER_OLD
  };

  const sameControlPlane = evaluateReentry({
    bootstrapLease,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROLLER_OLD,
    currentControllerHeadSha: CONTROLLER_OLD
  });

  assert.equal(sameControlPlane.runController, false);
  assert.equal(sameControlPlane.status, 'escalated-initial-budget-exhausted');
  assert.equal(sameControlPlane.nextAction, 'human-escalation');

  const materialFailure = evaluateReentry({
    bootstrapLease: {
      ...bootstrapLease,
      failureStage: 'material'
    },
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex',
    bootstrapControllerHeadSha: CONTROLLER_OLD,
    currentControllerHeadSha: CONTROLLER_NEW
  });

  assert.equal(materialFailure.runController, false);
  assert.equal(materialFailure.nextAction, 'human-escalation');
});

test('duplicate managed PRs fail closed rather than selecting one nondeterministically', () => {
  assert.throws(() => selectManagedPullRequest([
    pr(),
    pr({ number: 78, head: { ref: 'delivery/63-b', sha: HEAD_B } })
  ], { issueNumber: 63, baseBranch: 'main', repository: 'owner/repo', trustedLogin: 'owner' }), /multiple open PRs/);
});

test('state and bootstrap parsers reject ambiguity and preserve one canonical envelope', () => {
  const stateBody = `<!-- delivery-v2-state -->\n## Delivery V2 controller state\n\n\`\`\`json\n${JSON.stringify(envelope())}\n\`\`\``;
  const parsedState = parsePersistentStateEnvelope([{ id: 1, body: stateBody, user: { login: 'owner' }, author_association: 'OWNER' }], { trustedLogin: 'owner' });
  assert.equal(parsedState.commentId, 1);
  assert.equal(parsedState.persistent.pullRequestNumber, 77);
  assert.throws(() => parsePersistentStateEnvelope([{ id: 1, body: stateBody, user: { login: 'owner' }, author_association: 'OWNER' }, { id: 2, body: stateBody, user: { login: 'owner' }, author_association: 'OWNER' }], { trustedLogin: 'owner' }), /multiple Delivery V2 state comments/);
  assert.throws(() => parsePersistentStateEnvelope([{ id: 1, body: stateBody, user: { login: 'attacker' }, author_association: 'NONE' }], { trustedLogin: 'owner' }), /untrusted Delivery V2 state marker/);

  const bootstrapBody = `<!-- delivery-v2-bootstrap-state -->\n## Delivery V2 bootstrap state\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, repository: 'owner/repo', issueNumber: 63, baseBranch: 'main', provider: 'codex', requestedRisk: 'critical', effectiveRisk: 'critical', implementationAttempts: 1, status: 'reserved-initial-attempt', controllerRunId: 99, workerWorkflow: 'worker.yml', dispatchNonce: 'nonce-1' })}\n\`\`\``;
  const lease = parseBootstrapLease([{ id: 3, body: bootstrapBody, user: { login: 'owner' }, author_association: 'OWNER' }], { trustedLogin: 'owner' });
  assert.equal(lease.implementationAttempts, 1);
  assert.equal(lease.controllerRunId, 99);
});

test('resume rebuild keeps consumed implementation budget while reobserving a drifted head', () => {
  const previous = operationalStateFromPersistent(persistent({
    materialHeadSha: HEAD_A,
    classifier: { subjectSha: HEAD_A, version: 'v1', fingerprint: 'fp' },
    attempts: { implementation: 2, audit: 1, auditRemediation: 1 }
  }));
  const rebuilt = rebuildCiPendingState({ plan: planFor(), materialHeadSha: HEAD_B, previousState: previous });
  assert.equal(rebuilt.status, 'ci-pending');
  assert.equal(rebuilt.materialHeadSha, HEAD_B);
  assert.equal(rebuilt.implementationAttempts, 2);
  assert.equal(rebuilt.auditAttempts, 1);
  assert.equal(rebuilt.auditRemediationAttempts, 1);
});

test('issue 149: drift of an adopted epoch does not fabricate an implementation attempt', () => {
  const previous = operationalStateFromPersistent(persistent({
    materialHeadSha: HEAD_A,
    classifier: {
      subjectSha: HEAD_A,
      version: 'v1',
      fingerprint: 'fp'
    },
    attempts: {
      implementation: 0,
      audit: 1,
      auditRemediation: 0
    }
  }));

  const rebuilt = rebuildCiPendingState({
    plan: planFor(),
    materialHeadSha: HEAD_B,
    previousState: previous
  });

  assert.equal(rebuilt.status, 'ci-pending');
  assert.equal(rebuilt.materialHeadSha, HEAD_B);
  assert.equal(rebuilt.implementationAttempts, 0);
  assert.equal(rebuilt.auditAttempts, 1);
  assert.equal(rebuilt.auditRemediationAttempts, 0);
});

test('issue 149: a remediated candidate can reserve a fresh audit after a previous audit attempt', () => {
  const remediated = operationalStateFromPersistent(persistent({
    status: 'audit-pending',
    attempts: {
      implementation: 0,
      audit: 1,
      auditRemediation: 1
    },
    workflowChecks: [{
      name: 'required',
      subjectSha: HEAD_A,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 10,
      evidenceRef: 'run:10'
    }]
  }));

  assert.equal(
    shouldStartFreshAudit({
      state: remediated,
      controller: {
        auditRunId: null,
        auditDispatchNonce: null,
        materialWorkerRunId: 77,
        priorFindings: [{
          id: 'DV2-149-TEST',
          candidateSha: HEAD_B,
          status: 'remediated-pending-verification'
        }]
      }
    }),
    true
  );

  assert.equal(
    shouldStartFreshAudit({
      state: remediated,
      controller: {
        auditRunId: null,
        auditDispatchNonce: 'reserved-audit-nonce'
      }
    }),
    false
  );
});

test('issue 149: the initial legacy audit may reuse its pre-reserved nonce without being mistaken for an in-flight audit', () => {
  const initial = operationalStateFromPersistent(persistent({
    status: 'audit-pending',
    attempts: {
      implementation: 0,
      audit: 0,
      auditRemediation: 0
    }
  }));

  assert.equal(
    shouldStartFreshAudit({
      state: initial,
      controller: {
        auditRunId: null,
        auditDispatchNonce: 'legacy-pre-reserved-nonce'
      }
    }),
    true
  );
});

test('existing in-flight audit is restored without consuming another audit attempt', () => {
  const state = operationalStateFromPersistent(persistent({
    status: 'audit-pending',
    attempts: { implementation: 1, audit: 1, auditRemediation: 0 },
    workflowChecks: [{ name: 'required', subjectSha: HEAD_A, status: 'completed', conclusion: 'success', workflowRunId: 10, evidenceRef: 'run:10' }]
  }));
  const restored = markExistingAuditInFlight(state);
  assert.equal(restored.auditInFlight, true);
  assert.equal(restored.auditAttempts, 1);
});

test('CI failures require deterministic repository evidence before automatic remediation', () => {
  assert.equal(ciFailureClassForEvidence({ conclusion: 'failure', failedJobs: [{ name: 'test', failedStepNames: ['test'], log: 'Tests failed with AssertionError' }] }), 'actionable');
  assert.equal(ciFailureClassForEvidence({ conclusion: 'failure', failedJobs: [{ name: 'test', failedStepNames: [], log: 'service unavailable' }] }), 'external');
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'stale', 'neutral', 'skipped']) {
    assert.equal(ciFailureClassForEvidence({ conclusion, failedJobs: [] }), 'external');
  }
});


test('base drift routes resume back through deterministic classification', () => {
  const nextBase = 'd'.repeat(40);
  const decision = evaluateReentry({
    pullRequest: pr({ base: { ref: 'main', sha: nextBase } }),
    stateEnvelope: envelope(),
    bootstrapLease: null,
    targetRepository: 'owner/repo', issueNumber: 63, baseBranch: 'main', provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.staleStateDetected, true);
  assert.equal(decision.nextAction, 'classify');
});

test('new material metadata replaces producer identity and clears stale audit identity while carrying prior findings', () => {
  const metadata = controllerMetadataForNewMaterial({
    controller: { auditRunId: 50, auditDispatchNonce: 'old-audit', auditRequestFingerprint: 'old-fp', priorFindings: [{ id: 'DV2-OLD', candidateSha: HEAD_A, status: 'open' }] },
    workerRunId: 77,
    plan: planFor()
  });
  assert.equal(metadata.workerRunId, null);
  assert.equal(metadata.materialWorkerRunId, 77);
  assert.equal(metadata.materialWorkerIdentity, planFor().implementation.workflow);
  assert.equal(metadata.auditRunId, null);
  assert.equal(metadata.auditDispatchNonce, null);
  assert.equal(metadata.auditRequestFingerprint, null);
  assert.equal(metadata.priorFindings[0].status, 'remediated-pending-verification');
});
