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
import { markExistingAuditInFlight, rebuildCiPendingState } from '../scripts/resume-delivery-v2-controller.mjs';
import { ciFailureClassForConclusion } from '../src/v2/controller-runtime.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { operationalStateFromPersistent } from '../src/v2/operational-controller.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

function pr(overrides = {}) {
  return {
    number: 77,
    title: '[delivery-v2] fix issue 63',
    body: 'Closes #63',
    base: { ref: 'main', sha: BASE },
    head: { ref: 'delivery/63', sha: HEAD_A },
    ...overrides
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
  const selected = selectManagedPullRequest([], { issueNumber: 63, baseBranch: 'main' });
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
});

test('existing managed PR resumes persisted state through the controller instead of starting another initial worker', () => {
  const selected = selectManagedPullRequest([pr()], { issueNumber: 63, baseBranch: 'main' });
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

test('existing PR without state routes to deterministic PR recovery, never another initial worker', () => {
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
  assert.equal(decision.resumePr, 77);
  assert.equal(decision.nextAction, 'recover-pr-state');
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

test('duplicate managed PRs fail closed rather than selecting one nondeterministically', () => {
  assert.throws(() => selectManagedPullRequest([
    pr(),
    pr({ number: 78, head: { ref: 'delivery/63-b', sha: HEAD_B } })
  ], { issueNumber: 63, baseBranch: 'main' }), /multiple open Delivery V2 PRs/);
});

test('state and bootstrap parsers reject ambiguity and preserve one canonical envelope', () => {
  const stateBody = `<!-- delivery-v2-state -->\n## Delivery V2 controller state\n\n\`\`\`json\n${JSON.stringify(envelope())}\n\`\`\``;
  const parsedState = parsePersistentStateEnvelope([{ id: 1, body: stateBody }]);
  assert.equal(parsedState.commentId, 1);
  assert.equal(parsedState.persistent.pullRequestNumber, 77);
  assert.throws(() => parsePersistentStateEnvelope([{ id: 1, body: stateBody }, { id: 2, body: stateBody }]), /multiple Delivery V2 state comments/);

  const bootstrapBody = `<!-- delivery-v2-bootstrap-state -->\n## Delivery V2 bootstrap state\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, repository: 'owner/repo', issueNumber: 63, baseBranch: 'main', provider: 'codex', requestedRisk: 'critical', effectiveRisk: 'critical', implementationAttempts: 1, status: 'reserved-initial-attempt', controllerRunId: 99, workerWorkflow: 'worker.yml', dispatchNonce: 'nonce-1' })}\n\`\`\``;
  const lease = parseBootstrapLease([{ id: 3, body: bootstrapBody }]);
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

test('cancelled, timed out, stale or startup failures never become automatic code remediation', () => {
  assert.equal(ciFailureClassForConclusion('failure'), 'actionable');
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'stale', 'neutral', 'skipped']) {
    assert.equal(ciFailureClassForConclusion(conclusion), 'external');
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