import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDelivery,
  createDeliveryState,
  markTerminal,
  publishMaterial,
  recordAuditResult,
  recordCiResult,
  recordHeadDrift,
  remediationInputsFor,
  startAudit,
  startImplementation
} from '../src/v2/remediation-state-machine.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function begin(profile = 'critical') {
  return startImplementation(classifyDelivery(createDeliveryState({ repository: 'owner/repo', workItem: 'issue#27', riskProfile: profile })));
}

function publish(state, sha = A) {
  return publishMaterial(state, { materialHeadSha: sha });
}

function ciSuccess(state) {
  return recordCiResult(state, { candidateSha: state.materialHeadSha, conclusion: 'success', evidenceRef: `run:${state.materialHeadSha.slice(0, 7)}` });
}

function blockingFinding(sha, id = 'DV2-TEST-001') {
  return { id, candidateSha: sha, severity: 'high', violatedContract: 'test contract', blocksRelease: true, remediationMode: 'targeted', surface: 'src/example.mjs', failureMode: 'contract violation', evidence: 'discriminating evidence' };
}

test('CRITICAL happy path is deterministic and reaches ready-for-human-merge with independent audit budget accounted', () => {
  let state = publish(begin('critical'));
  assert.equal(state.implementationAttempts, 1);
  state = ciSuccess(state);
  assert.equal(state.status, 'audit-pending');
  state = startAudit(state);
  assert.equal(state.auditAttempts, 1);
  state = recordAuditResult(state, { candidateSha: A, decision: 'approved', evidenceRef: 'audit:1' });
  assert.equal(state.status, 'ready-for-human-merge');
  assert.equal(state.controls.automaticMergeAllowed, false);
  state = markTerminal(state, { reason: 'human-merged' });
  assert.equal(state.status, 'terminal');
});

test('FAST skips audit after green exact-SHA CI', () => {
  const state = ciSuccess(publish(begin('fast')));
  assert.equal(state.status, 'ready-for-human-merge');
  assert.equal(state.auditAttempts, 0);
});

test('actionable CI failure consumes current attempt and remediation is bounded by risk policy', () => {
  let state = publish(begin('fast'));
  state = recordCiResult(state, { candidateSha: A, conclusion: 'failure', failureClass: 'actionable', cause: 'test failure', evidenceRef: 'run:1' });
  assert.equal(state.status, 'ci-failed-remediable');
  assert.equal(remediationInputsFor(state).source, 'ci-failure');
  state = startImplementation(state);
  assert.equal(state.implementationAttempts, 2);
  state = publish(state, B);
  state = recordCiResult(state, { candidateSha: B, conclusion: 'failure', failureClass: 'actionable', cause: 'same failure', evidenceRef: 'run:2' });
  assert.equal(state.status, 'escalated');
  assert.equal(state.escalation.reason, 'implementation-budget-exhausted');
});

test('external or preexisting CI failures never authorize unrelated code remediation or consume another attempt', () => {
  for (const failureClass of ['external', 'preexisting']) {
    const initial = publish(begin('standard'));
    const state = recordCiResult(initial, { candidateSha: A, conclusion: 'failure', failureClass, cause: 'runner unavailable', evidenceRef: 'run:external' });
    assert.equal(state.status, 'ci-pending');
    assert.equal(state.implementationAttempts, 1);
    assert.throws(() => remediationInputsFor(state), /no remediation input/);
  }
});

test('audit rejection exposes only blocking findings plus explicitly new risk surfaces as remediation input', () => {
  let state = ciSuccess(publish(begin('critical')));
  state = startAudit(state);
  state = recordAuditResult(state, { candidateSha: A, decision: 'rejected', evidenceRef: 'audit:1', findings: [blockingFinding(A)] });
  assert.equal(state.status, 'audit-failed-remediable');
  const input = remediationInputsFor(state, { newRiskSurfaces: ['src/new-boundary.mjs'] });
  assert.equal(input.source, 'audit-findings');
  assert.deepEqual(input.findings.map((finding) => finding.id), ['DV2-TEST-001']);
  assert.deepEqual(input.newRiskSurfaces, ['src/new-boundary.mjs']);
});

test('audit remediation uses its own budget when the initial implementation budget is exhausted', () => {
  let state = publish(begin('critical'), A);
  state = recordCiResult(state, { candidateSha: A, conclusion: 'failure', failureClass: 'actionable', cause: 'test failure', evidenceRef: 'run:1' });
  state = publish(startImplementation(state), B);
  state = recordCiResult(state, { candidateSha: B, conclusion: 'failure', failureClass: 'actionable', cause: 'test failure', evidenceRef: 'run:2' });
  state = startAudit(ciSuccess(publish(startImplementation(state), C)));

  assert.equal(state.implementationAttempts, state.limits.maxImplementationAttempts);
  assert.equal(state.auditRemediationAttempts, 0);
  state = recordAuditResult(state, { candidateSha: C, decision: 'rejected', evidenceRef: 'audit:1', findings: [blockingFinding(C)] });
  assert.equal(state.status, 'audit-failed-remediable');

  state = startImplementation(state);
  assert.equal(state.status, 'implementing');
  assert.equal(state.implementationAttempts, state.limits.maxImplementationAttempts);
  assert.equal(state.auditRemediationAttempts, 1);
});

test('audit context insufficiency escalates deterministically without authorizing implementation remediation', () => {
  let state = startAudit(ciSuccess(publish(begin('critical'))));
  state = recordAuditResult(state, {
    candidateSha: A,
    decision: 'rejected',
    evidenceRef: 'audit:context',
    findings: [blockingFinding(A, 'DV2-AUDIT-CONTEXT-INSUFFICIENT')]
  });
  assert.equal(state.status, 'escalated');
  assert.equal(state.terminalReason, 'audit-context-insufficient');
  assert.equal(state.escalation.reason, 'audit-context-insufficient');
  assert.deepEqual(state.escalation.findingIds, ['DV2-AUDIT-CONTEXT-INSUFFICIENT']);
  assert.equal(state.implementationAttempts, 1);
  assert.equal(state.auditRemediationAttempts, 0);
  assert.throws(() => remediationInputsFor(state), /no remediation input/);
});

test('rejected audit without actionable blocking findings fails closed', () => {
  const state = startAudit(ciSuccess(publish(begin('critical'))));
  assert.throws(() => recordAuditResult(state, { candidateSha: A, decision: 'rejected', evidenceRef: 'audit:1', findings: [] }), /release-blocking findings/);
});

test('material remediation SHA invalidates old CI and audit evidence', () => {
  let state = startAudit(ciSuccess(publish(begin('critical'))));
  state = recordAuditResult(state, { candidateSha: A, decision: 'rejected', evidenceRef: 'audit:1', findings: [blockingFinding(A)] });
  state = startImplementation(state);
  state = publish(state, B);
  assert.equal(state.status, 'ci-pending');
  assert.equal(state.ciEvidence, null);
  assert.equal(state.auditEvidence, null);
  assert.deepEqual(state.blockingFindings, []);
  assert.throws(() => recordCiResult(state, { candidateSha: A, conclusion: 'success', evidenceRef: 'run:old' }), /stale/);
});

test('STANDARD permits one audit-remediation cycle and escalates after the next rejection', () => {
  let state = ciSuccess(publish(begin('standard')));
  state = startAudit(state);
  state = recordAuditResult(state, { candidateSha: A, decision: 'rejected', evidenceRef: 'audit:1', findings: [blockingFinding(A)] });
  assert.equal(state.status, 'audit-failed-remediable');
  state = startImplementation(state);
  assert.equal(state.auditRemediationAttempts, 1);
  assert.equal(state.implementationAttempts, 1);
  state = ciSuccess(publish(state, B));
  state = startAudit(state);
  state = recordAuditResult(state, { candidateSha: B, decision: 'rejected', evidenceRef: 'audit:2', findings: [blockingFinding(B, 'DV2-TEST-002')] });
  assert.equal(state.status, 'escalated');
  assert.equal(state.escalation.reason, 'audit-remediation-budget-exhausted');
  assert.equal(state.escalation.auditAttempts, 2);
  assert.equal(state.escalation.auditRemediationAttempts, 1);
  assert.equal(state.escalation.maxAuditRemediationAttempts, 1);
  assert.equal(state.escalation.blockingFindings[0].id, 'DV2-TEST-002');
});

test('remote head drift invalidates evidence and returns to queued classification without resetting budgets', () => {
  let state = startAudit(ciSuccess(publish(begin('critical'))));
  state = recordAuditResult(state, { candidateSha: A, decision: 'approved', evidenceRef: 'audit:1' });
  const drifted = recordHeadDrift(state, { materialHeadSha: C });
  assert.equal(drifted.status, 'queued');
  assert.equal(drifted.materialHeadSha, C);
  assert.equal(drifted.ciEvidence, null);
  assert.equal(drifted.auditEvidence, null);
  assert.equal(drifted.implementationAttempts, 1);
  assert.equal(drifted.auditAttempts, 1);
});

test('controller exposes no recursive AI orchestration or automatic merge authority', () => {
  const state = createDeliveryState({ repository: 'owner/repo', workItem: 'issue#27', riskProfile: 'critical' });
  assert.equal(state.controls.recursiveAiOrchestrationAllowed, false);
  assert.equal(state.controls.automaticMergeAllowed, false);
});

test('invalid transitions fail closed instead of guessing a next state', () => {
  const state = createDeliveryState({ repository: 'owner/repo', workItem: 'issue#27', riskProfile: 'critical' });
  assert.throws(() => recordCiResult(state, { candidateSha: A, conclusion: 'success', evidenceRef: 'run:1' }), /cannot record CI/);
  assert.throws(() => startAudit(state), /cannot start audit/);
});
