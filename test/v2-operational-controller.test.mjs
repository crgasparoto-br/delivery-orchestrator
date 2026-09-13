import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import {
  applyOperationalEvent,
  createOperationalDelivery,
  evaluateOperationalRelease,
  nextOperationalAction,
  operationalRemediationInput,
  persistentStateFromOperational,
  operationalStateFromPersistent
} from '../src/v2/operational-controller.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function planFor(risk = 'critical') {
  return createDeliveryPlan({
    requestedRisk: risk,
    changedPaths: ['src/v2/operational-controller.mjs'],
    repositoryPolicy: {},
    repository: 'owner/repo',
    issueNumber: 63,
    providers: {
      implementer: { provider: 'codex', model: 'auto' },
      auditor: { provider: 'codex', model: 'auto' }
    }
  });
}

function identity(provider = 'codex') {
  return { issueNumber: 63, pullRequestNumber: 77, baseRef: 'main', baseSha: B, headRef: 'feat/63', provider };
}

test('normal path composes implementation -> CI -> audit -> ready without conversational orchestration', () => {
  let state = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  assert.equal(state.status, 'ci-pending');
  assert.equal(state.implementationAttempts, 1);
  assert.equal(nextOperationalAction(state), 'observe-ci');

  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: A, conclusion: 'success', evidenceRef: 'run:1' } });
  assert.equal(state.status, 'audit-pending');
  assert.equal(nextOperationalAction(state), 'dispatch-audit');

  state = applyOperationalEvent(state, { type: 'audit-result', result: { candidateSha: A, decision: 'approved', evidenceRef: 'audit:1' } });
  assert.equal(state.status, 'ready-for-human-merge');
  assert.equal(state.auditAttempts, 1);
});

test('actionable CI failure becomes the only bounded remediation input and preserves attempt budget', () => {
  let state = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  state = applyOperationalEvent(state, {
    type: 'ci-result',
    result: { candidateSha: A, conclusion: 'failure', failureClass: 'actionable', cause: 'tests failed', evidenceRef: 'run:2' }
  });
  assert.equal(state.status, 'ci-failed-remediable');
  const remediation = operationalRemediationInput(state);
  assert.equal(remediation.source, 'ci-failure');
  assert.equal(remediation.ciFailure.cause, 'tests failed');
  state = applyOperationalEvent(state, { type: 'start-implementation' });
  assert.equal(state.implementationAttempts, 2);
  assert.equal(state.status, 'implementing');
});

test('persistent projection binds state and evidence to the exact material head', () => {
  let state = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: A, conclusion: 'success', evidenceRef: 'run:1' } });
  const persistent = persistentStateFromOperational({
    state,
    identity: identity(),
    classifier: { version: 'v1', fingerprint: 'fingerprint' },
    workflowChecks: [{ name: 'required', subjectSha: A, status: 'completed', conclusion: 'success', workflowRunId: 1, evidenceRef: 'run:1' }],
    evidenceRefs: ['run:1']
  });
  assert.equal(persistent.materialHeadSha, A);
  assert.equal(persistent.status, 'audit-pending');
  assert.equal(persistent.attempts.implementation, 1);
  assert.equal(persistent.classifier.subjectSha, A);
});

test('release evaluation is impossible before operational state is ready', () => {
  const state = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  const result = evaluateOperationalRelease({ state, releaseInput: {} });
  assert.equal(result.readiness, false);
  assert.deepEqual(result.reasons, ['operational-state:ci-pending']);
});


test('persistent resume preserves actionable CI and semantic audit remediation packets without degradation', () => {
  let ciState = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  ciState = applyOperationalEvent(ciState, { type: 'ci-result', result: { candidateSha: A, conclusion: 'failure', failureClass: 'actionable', cause: 'unit assertion failed', evidenceRef: 'run:ci-fail' } });
  const ciPersistent = persistentStateFromOperational({ state: ciState, identity: identity(), classifier: { version: 'v1', fingerprint: 'fingerprint' } });
  const ciRestored = operationalStateFromPersistent(ciPersistent);
  assert.deepEqual(operationalRemediationInput(ciRestored).ciFailure, ciState.ciFailure);

  let auditState = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  auditState = applyOperationalEvent(auditState, { type: 'ci-result', result: { candidateSha: A, conclusion: 'success', evidenceRef: 'run:ok' } });
  auditState = applyOperationalEvent(auditState, { type: 'audit-result', result: { candidateSha: A, decision: 'rejected', evidenceRef: 'audit:reject', findings: [{ id: 'DV2-TEST-ROUNDTRIP', candidateSha: A, severity: 'critical', violatedContract: 'DV2-009', blocksRelease: true, remediationMode: 'systemic', surface: 'src/v2/example.mjs', failureMode: 'resume loses evidence', evidence: 'round-trip mismatch' }] } });
  const auditPersistent = persistentStateFromOperational({ state: auditState, identity: identity(), classifier: { version: 'v1', fingerprint: 'fingerprint' } });
  const auditRestored = operationalStateFromPersistent(auditPersistent);
  assert.deepEqual(operationalRemediationInput(auditRestored).findings, auditState.blockingFindings);
  assert.deepEqual(auditRestored.auditEvidence, auditState.auditEvidence);
});
