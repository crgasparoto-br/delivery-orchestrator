import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  classifyDelivery,
  createDeliveryState,
  markTerminal,
  publishMaterial,
  recordAuditResult,
  recordCiResult,
  remediationInputsFor,
  startAudit,
  startImplementation
} from '../src/v2/remediation-state-machine.mjs';

async function loadEvidence() {
  return JSON.parse(await readFile(new URL('../docs/delivery-v2/evidence/dv2-009-bounded-remediation.json', import.meta.url), 'utf8'));
}

function ciEvidence(candidate) {
  return `github-actions:${candidate.ci.workflowRunId}`;
}

function auditEvidence(candidate) {
  return `github-actions:${candidate.audit.workflowRunId}`;
}

test('DV2-009 replays the real PR #48 rejection -> CI remediation -> approval sequence within CRITICAL budgets', async () => {
  const evidence = await loadEvidence();
  const [first, second, third] = evidence.timeline;

  assert.equal(evidence.requirement, 'DV2-009');
  assert.equal(evidence.riskProfile, 'critical');
  assert.deepEqual(evidence.policy, {
    maxImplementationAttempts: 3,
    maxAuditRemediationAttempts: 2,
    maxAuditRunsIncludingInitial: 3
  });

  let state = createDeliveryState({
    repository: evidence.repository,
    workItem: `pull-request#${evidence.pullRequestNumber}`,
    riskProfile: evidence.riskProfile
  });
  state = classifyDelivery(state);
  state = startImplementation(state);
  assert.equal(state.implementationAttempts, first.implementationAttempt);
  assert.equal(state.limits.maxImplementationAttempts, evidence.policy.maxImplementationAttempts);
  assert.equal(state.limits.maxAuditRemediationAttempts, evidence.policy.maxAuditRemediationAttempts);

  state = publishMaterial(state, { materialHeadSha: first.candidateSha });
  state = recordCiResult(state, {
    candidateSha: first.candidateSha,
    conclusion: first.ci.conclusion,
    evidenceRef: ciEvidence(first)
  });
  assert.equal(state.status, 'audit-pending');

  state = startAudit(state);
  assert.equal(state.auditAttempts, 1);
  state = recordAuditResult(state, {
    candidateSha: first.candidateSha,
    decision: first.audit.decision,
    evidenceRef: auditEvidence(first),
    findings: first.audit.blockingFindings
  });
  assert.equal(state.status, 'audit-failed-remediable');
  assert.deepEqual(
    remediationInputsFor(state).findings.map((finding) => finding.id),
    ['DV2-008-EVIDENCE-REGRESSION-NONDISCRIMINATING']
  );

  state = startImplementation(state);
  assert.equal(state.implementationAttempts, second.implementationAttempt);
  assert.equal(state.auditRemediationAttempts, second.auditRemediationAttempt);
  state = publishMaterial(state, { materialHeadSha: second.candidateSha });
  assert.equal(state.auditEvidence, null);
  assert.deepEqual(state.blockingFindings, []);
  assert.throws(
    () => recordCiResult(state, {
      candidateSha: first.candidateSha,
      conclusion: 'success',
      evidenceRef: ciEvidence(first)
    }),
    /stale/
  );

  state = recordCiResult(state, {
    candidateSha: second.candidateSha,
    conclusion: second.ci.conclusion,
    failureClass: second.ci.failureClass,
    cause: second.ci.cause,
    evidenceRef: ciEvidence(second)
  });
  assert.equal(state.status, 'ci-failed-remediable');
  assert.equal(remediationInputsFor(state).ciFailure.failureClass, 'actionable');

  state = startImplementation(state);
  assert.equal(state.implementationAttempts, third.implementationAttempt);
  assert.equal(state.auditRemediationAttempts, third.auditRemediationAttempt);
  state = publishMaterial(state, { materialHeadSha: third.candidateSha });

  const boundedFailure = recordCiResult(state, {
    candidateSha: third.candidateSha,
    conclusion: 'failure',
    failureClass: 'actionable',
    cause: 'counterfactual third-attempt actionable failure',
    evidenceRef: 'counterfactual:third-attempt-failure'
  });
  assert.equal(boundedFailure.status, evidence.boundedAlternative.expectedState);
  assert.equal(boundedFailure.escalation.reason, evidence.boundedAlternative.expectedReason);
  assert.equal(boundedFailure.implementationAttempts, evidence.policy.maxImplementationAttempts);

  state = recordCiResult(state, {
    candidateSha: third.candidateSha,
    conclusion: third.ci.conclusion,
    evidenceRef: ciEvidence(third)
  });
  assert.equal(state.status, 'audit-pending');
  state = startAudit(state);
  assert.equal(state.auditAttempts, evidence.observedCounters.auditAttempts);
  state = recordAuditResult(state, {
    candidateSha: third.candidateSha,
    decision: third.audit.decision,
    evidenceRef: auditEvidence(third),
    findings: third.audit.blockingFindings
  });

  assert.equal(state.status, evidence.observedOutcome.stateBeforeMerge);
  assert.equal(state.implementationAttempts, evidence.observedCounters.implementationAttempts);
  assert.equal(state.auditAttempts, evidence.observedCounters.auditAttempts);
  assert.equal(state.auditRemediationAttempts, evidence.observedCounters.auditRemediationAttempts);
  assert.equal(state.controls.recursiveAiOrchestrationAllowed, false);
  assert.equal(state.controls.automaticMergeAllowed, false);

  state = markTerminal(state, { reason: evidence.observedOutcome.terminalReasonForReplay });
  assert.equal(state.status, 'terminal');
  assert.equal(state.terminalReason, 'authorized-merge-completed');
});

test('DV2-009 live evidence is exact-SHA/run bound and records the observed terminal merge', async () => {
  const evidence = await loadEvidence();
  const [first, second, third] = evidence.timeline;

  assert.equal(first.candidateSha, '1971fb5751dd99883c6772094bd4b1448fb4089e');
  assert.equal(first.ci.workflowRunId, 34690291734);
  assert.equal(first.audit.workflowRunId, 34690327617);
  assert.equal(first.audit.decision, 'rejected');
  assert.equal(first.audit.blockingFindings.length, 1);

  assert.equal(second.candidateSha, '6de29792e0f9a828ee6332d756ffbe82aa964615');
  assert.equal(second.ci.workflowRunId, 34690481605);
  assert.equal(second.ci.conclusion, 'failure');
  assert.equal(second.ci.failureClass, 'actionable');

  assert.equal(third.candidateSha, 'c403eaf94fcd10b9fae6da3b781be3a3955e273c');
  assert.equal(third.ci.workflowRunId, 34690592843);
  assert.equal(third.audit.workflowRunId, 34690625580);
  assert.equal(third.audit.decision, 'approved');
  assert.deepEqual(third.audit.blockingFindings, []);
  assert.equal(third.audit.requestFingerprint, '363824d1c8391469fb0003351b58da757907d298bb6b2f2617e83cd51e8ac6a8');

  assert.equal(evidence.observedOutcome.merged, true);
  assert.equal(evidence.observedOutcome.mergeCommitSha, '134fea2c8dffd4db5678935e5ab2386585f0169c');
});
