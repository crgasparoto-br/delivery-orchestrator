import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersistentDeliveryState } from '../src/v2/persistent-state.mjs';
import {
  evaluateReentry,
  parsePersistentStateEnvelope,
  selectManagedPullRequest
} from '../scripts/guard-delivery-v2-reentry.mjs';

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
  return {
    persistent: state,
    controller: { nextAction: 'observe-ci' }
  };
}

test('no managed PR allows exactly one initial controller run', () => {
  const selected = selectManagedPullRequest([], { issueNumber: 63, baseBranch: 'main' });
  assert.equal(selected, null);
  const decision = evaluateReentry({
    pullRequest: selected,
    stateEnvelope: null,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.nextAction, 'dispatch-initial-worker');
});

test('existing managed PR resumes persisted state instead of dispatching another initial worker', () => {
  const selected = selectManagedPullRequest([pr()], { issueNumber: 63, baseBranch: 'main' });
  const decision = evaluateReentry({
    pullRequest: selected,
    stateEnvelope: envelope(),
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, false);
  assert.equal(decision.status, 'resume-existing-delivery');
  assert.equal(decision.nextAction, 'observe-ci');
  assert.equal(decision.staleStateDetected, false);
  assert.equal(decision.attempts.implementation, 1);
});

test('head drift is reconciled without a new provider call and returns to deterministic classification', () => {
  const decision = evaluateReentry({
    pullRequest: pr({ head: { ref: 'delivery/63', sha: HEAD_B } }),
    stateEnvelope: envelope(),
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, false);
  assert.equal(decision.staleStateDetected, true);
  assert.equal(decision.materialHeadSha, HEAD_B);
  assert.equal(decision.nextAction, 'classify');
  assert.equal(decision.attempts.implementation, 1);
});

test('existing managed PR without durable state fails closed before any new worker', () => {
  const decision = evaluateReentry({
    pullRequest: pr(),
    stateEnvelope: null,
    targetRepository: 'owner/repo',
    issueNumber: 63,
    baseBranch: 'main',
    provider: 'codex'
  });
  assert.equal(decision.runController, false);
  assert.equal(decision.status, 'blocked-existing-pr-without-state');
  assert.equal(decision.nextAction, 'recover-persistent-state');
});

test('ambiguous duplicate managed PRs are rejected rather than selecting one', () => {
  assert.throws(() => selectManagedPullRequest([
    pr(),
    pr({ number: 78, head: { ref: 'delivery/63-b', sha: HEAD_B } })
  ], { issueNumber: 63, baseBranch: 'main' }), /multiple open Delivery V2 PRs/);
});

test('state comment parser rejects ambiguity and preserves one canonical envelope', () => {
  const body = `<!-- delivery-v2-state -->\n## Delivery V2 controller state\n\n\`\`\`json\n${JSON.stringify(envelope())}\n\`\`\``;
  const parsed = parsePersistentStateEnvelope([{ id: 1, body }]);
  assert.equal(parsed.commentId, 1);
  assert.equal(parsed.persistent.pullRequestNumber, 77);
  assert.throws(() => parsePersistentStateEnvelope([{ id: 1, body }, { id: 2, body }]), /multiple Delivery V2 state comments/);
});
