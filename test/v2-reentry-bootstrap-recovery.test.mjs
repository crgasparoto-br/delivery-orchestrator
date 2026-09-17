import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReentry, selectManagedPullRequest } from '../scripts/guard-delivery-v2-reentry.mjs';

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
