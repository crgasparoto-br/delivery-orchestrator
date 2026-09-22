import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import {
  applyOperationalEvent,
  createAdoptedOperationalDelivery,
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
    aiPolicy: {
      implementerProvider: 'codex',
      implementerModel: 'gpt-5.4',
      auditorProvider: 'claude',
      auditorModel: 'claude-opus-5'
    }
  });
}

function identity(provider = 'codex') {
  return { issueNumber: 63, pullRequestNumber: 77, baseRef: 'main', baseSha: B, headRef: 'feat/63', provider };
}

function fastPlanFor() {
  return createDeliveryPlan({ requestedRisk: 'fast', changedPaths: ['apps/web/src/components/Filter.tsx'], repositoryPolicy: { fastSafeRoots: ['apps/web/src/components'] }, repository: 'owner/repo', issueNumber: 63, aiPolicy: { implementerProvider: 'codex', implementerModel: 'gpt-5.4', auditorProvider: 'claude', auditorModel: 'claude-opus-5' } });
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
  assert.equal(state.status, 'technical-hygiene-pending');
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: { schemaVersion: 1, baselineSha: B, materialSha: A, result: 'PASS', effectiveProfile: 'critical', evidenceRef: 'artifact:hygiene' } });
  assert.equal(state.status, 'ready-for-human-merge');
  assert.equal(state.auditAttempts, 1);
});

test('issue 149: adopted operational epoch imports exact-head green CI without fabricating an implementation attempt', () => {
  const state = createAdoptedOperationalDelivery({
    plan: planFor('critical'),
    materialHeadSha: A,
    ciEvidence: { evidenceRef: 'run:legacy-green' }
  });

  assert.equal(state.status, 'audit-pending');
  assert.equal(state.materialHeadSha, A);
  assert.equal(state.implementationAttempts, 0);
  assert.equal(state.auditAttempts, 0);
  assert.equal(state.auditRemediationAttempts, 0);
  assert.equal(state.ciEvidence.candidateSha, A);
  assert.equal(state.ciEvidence.conclusion, 'success');
  assert.equal(state.ciEvidence.evidenceRef, 'run:legacy-green');
  assert.equal(nextOperationalAction(state), 'dispatch-audit');
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

test('persistent projection binds state, evidence and effective AI identity to the exact material head', () => {
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
  assert.equal(persistent.provider, 'codex');
  assert.equal(persistent.model, 'gpt-5.4');
  assert.equal(persistent.auditorProvider, 'claude');
  assert.equal(persistent.auditorModel, 'claude-opus-5');

  const restored = operationalStateFromPersistent(persistent);
  assert.equal(restored.implementerProvider, 'codex');
  assert.equal(restored.implementerModel, 'gpt-5.4');
  assert.equal(restored.auditorProvider, 'claude');
  assert.equal(restored.auditorModel, 'claude-opus-5');
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
  assert.equal(ciRestored.implementerModel, 'gpt-5.4');
  assert.equal(ciRestored.auditorModel, 'claude-opus-5');

  let auditState = createOperationalDelivery({ plan: planFor('critical'), materialHeadSha: A });
  auditState = applyOperationalEvent(auditState, { type: 'ci-result', result: { candidateSha: A, conclusion: 'success', evidenceRef: 'run:ok' } });
  auditState = applyOperationalEvent(auditState, { type: 'audit-result', result: { candidateSha: A, decision: 'rejected', evidenceRef: 'audit:reject', findings: [{ id: 'DV2-TEST-ROUNDTRIP', candidateSha: A, severity: 'critical', violatedContract: 'DV2-009', blocksRelease: true, remediationMode: 'systemic', surface: 'src/v2/example.mjs', failureMode: 'resume loses evidence', evidence: 'round-trip mismatch' }] } });
  const auditPersistent = persistentStateFromOperational({ state: auditState, identity: identity(), classifier: { version: 'v1', fingerprint: 'fingerprint' } });
  const auditRestored = operationalStateFromPersistent(auditPersistent);
  assert.deepEqual(operationalRemediationInput(auditRestored).findings, auditState.blockingFindings);
  assert.deepEqual(auditRestored.auditEvidence, auditState.auditEvidence);
  assert.equal(auditRestored.implementerProvider, 'codex');
  assert.equal(auditRestored.auditorProvider, 'claude');
});


test('operational release fails closed until exact-head technical hygiene is attached', () => {
  let state = createOperationalDelivery({ plan: fastPlanFor(), materialHeadSha: A });
  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: A, conclusion: 'success', evidenceRef: 'run:ok' } });
  const releaseInput = { schemaVersion: 1, repository: 'owner/repo', pullRequestNumber: 77, materialHeadSha: A, currentRemoteHeadSha: A, evidenceCollection: { materialHeadSha: A, remoteHeadSha: A, evidenceRef: 'collection' }, classifier: { subjectSha: A, profile: 'fast', version: 'v1', fingerprint: 'x', expectedFingerprint: 'x', evidenceRef: 'classifier' }, checks: [{ name: 'ci', required: true, subjectSha: A, status: 'completed', conclusion: 'success', workflowRunId: 1, evidenceRef: 'ci' }], standardAuditRequired: false, unresolvedFindings: [], blockers: [] };
  let release = evaluateOperationalRelease({ state, releaseInput });
  assert.equal(release.readiness, false);
  assert.deepEqual(release.reasons, ['operational-state:technical-hygiene-pending']);
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: { schemaVersion: 1, baselineSha: B, materialSha: A, previousMaterialSha: null, result: 'PASS', effectiveProfile: 'fast', promotionRequired: false, missingEvidence: [], evidenceRef: 'artifact:hygiene' } });
  release = evaluateOperationalRelease({ state, releaseInput });
  assert.equal(release.readiness, true);
});

test('new material invalidates prior technical hygiene approval', () => {
  let state = createOperationalDelivery({ plan: fastPlanFor(), materialHeadSha: A });
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: { schemaVersion: 1, baselineSha: B, materialSha: A, previousMaterialSha: null, result: 'PASS', effectiveProfile: 'fast', promotionRequired: false, missingEvidence: [], evidenceRef: 'artifact:hygiene' } });
  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: A, conclusion: 'failure', failureClass: 'actionable', cause: 'test-remediation', evidenceRef: 'run:failed' } });
  state = applyOperationalEvent(state, { type: 'start-implementation' });
  state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha: B });
  assert.equal(state.technicalHygiene, null);
});


test('technical hygiene promotion upgrades FAST operational risk to STANDARD', () => {
  let state = createOperationalDelivery({ plan: fastPlanFor(), materialHeadSha: A });
  const promotedPlan = createDeliveryPlan({ requestedRisk: 'standard', changedPaths: ['apps/web/src/components/Filter.tsx'], repositoryPolicy: { fastSafeRoots: ['apps/web/src/components'] }, repository: 'owner/repo', issueNumber: 63, aiPolicy: { implementerProvider: 'codex', implementerModel: 'gpt-5.4', auditorProvider: 'claude', auditorModel: 'claude-opus-5' } });
  state = applyOperationalEvent(state, { type: 'promote-risk', plan: promotedPlan });
  assert.equal(state.riskProfile, 'standard');
  assert.equal(state.auditRequired, true);
});
