import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyPersistentCheckpoint,
  createPersistentDeliveryState,
  loadPersistentDeliveryState,
  reconcilePersistentState,
  resumePersistentDelivery,
  savePersistentDeliveryState
} from '../src/v2/persistent-state.mjs';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE = 'cccccccccccccccccccccccccccccccccccccccc';

function stateInput(overrides = {}) {
  return {
    repository: 'acme/example',
    issueNumber: 41,
    pullRequestNumber: 42,
    baseRef: 'main',
    baseSha: BASE,
    headRef: 'feat/example',
    materialHeadSha: SHA_A,
    effectiveRisk: 'critical',
    classifier: {
      subjectSha: SHA_A,
      version: 'v2',
      fingerprint: 'classifier-fp'
    },
    provider: 'codex',
    status: 'ci-pending',
    attempts: { implementation: 1, audit: 0, auditRemediation: 0 },
    workflowChecks: [],
    blockingFindings: [],
    evidenceRefs: ['github:pr/42'],
    lastReason: 'awaiting-ci',
    ...overrides
  };
}

function observed(remoteHeadSha = SHA_A, overrides = {}) {
  return {
    repository: 'acme/example',
    pullRequestNumber: 42,
    headRef: 'feat/example',
    baseSha: BASE,
    remoteHeadSha,
    ...overrides
  };
}

test('persistent state retains the minimum resumable Delivery V2 identity and evidence', () => {
  const state = createPersistentDeliveryState(stateInput({
    workflowChecks: [{
      name: 'Validate repository',
      subjectSha: SHA_A,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 1001,
      evidenceRef: 'github:check/1001'
    }],
    blockingFindings: [{
      id: 'DV2-AUDIT-001',
      candidateSha: SHA_A,
      surface: 'src/api.mjs',
      failureMode: 'missing guard',
      evidenceRef: 'github:finding/1'
    }]
  }));

  assert.equal(state.repository, 'acme/example');
  assert.equal(state.materialHeadSha, SHA_A);
  assert.equal(state.effectiveRisk, 'critical');
  assert.equal(state.classifier.fingerprint, 'classifier-fp');
  assert.equal(state.provider, 'codex');
  assert.equal(state.attempts.implementation, 1);
  assert.equal(state.workflowChecks[0].workflowRunId, 1001);
  assert.equal(state.blockingFindings[0].id, 'DV2-AUDIT-001');
  assert.equal(state.lastReason, 'awaiting-ci');
});

test('save/load round trip is durable and schema validated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dv2-state-'));
  const filePath = join(dir, 'state.json');
  const state = createPersistentDeliveryState(stateInput());

  await savePersistentDeliveryState(filePath, state);
  const loaded = await loadPersistentDeliveryState(filePath);
  assert.deepEqual(loaded, state);

  const serialized = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(serialized.schemaVersion, 1);
  assert.equal(serialized.materialHeadSha, SHA_A);
});

test('repeating the same checkpoint transition ID is exactly idempotent', () => {
  const state = createPersistentDeliveryState(stateInput());
  const checkpoint = {
    transitionId: 'ci-success:1001',
    observed: observed(),
    status: 'audit-pending',
    attempts: { implementation: 1, audit: 0, auditRemediation: 0 },
    workflowChecks: [{
      name: 'Validate repository',
      subjectSha: SHA_A,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 1001,
      evidenceRef: 'github:check/1001'
    }],
    evidenceRefs: ['github:pr/42', 'github:check/1001'],
    lastReason: 'ci-green'
  };

  const once = applyPersistentCheckpoint(state, checkpoint);
  const twice = applyPersistentCheckpoint(once, checkpoint);

  assert.deepEqual(twice, once);
  assert.equal(once.revision, 1);
  assert.deepEqual(once.appliedTransitionIds, ['ci-success:1001']);
});

test('attempt counters are monotonic and bounded by effective risk', () => {
  const state = createPersistentDeliveryState(stateInput({
    attempts: { implementation: 2, audit: 1, auditRemediation: 1 }
  }));

  assert.throws(() => applyPersistentCheckpoint(state, {
    transitionId: 'bad-counter',
    observed: observed(),
    attempts: { implementation: 1, audit: 1, auditRemediation: 1 }
  }), /attempt counter cannot decrease/);

  assert.throws(() => createPersistentDeliveryState(stateInput({
    attempts: { implementation: 4, audit: 0, auditRemediation: 0 }
  })), /exceeds effective risk budget/);
});

test('fresh remote head wins over stale persisted SHA and invalidates candidate-bound evidence', () => {
  const state = createPersistentDeliveryState(stateInput({
    status: 'ready-for-human-merge',
    workflowChecks: [{
      name: 'Validate repository',
      subjectSha: SHA_A,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 1001,
      evidenceRef: 'github:check/1001'
    }],
    evidenceRefs: ['github:check/1001']
  }));

  const result = reconcilePersistentState(state, observed(SHA_B));

  assert.equal(result.staleStateDetected, true);
  assert.equal(result.nextAction, 'classify');
  assert.equal(result.state.materialHeadSha, SHA_B);
  assert.equal(result.state.status, 'queued');
  assert.equal(result.state.classifier.current, false);
  assert.deepEqual(result.state.workflowChecks, []);
  assert.deepEqual(result.state.blockingFindings, []);
  assert.deepEqual(result.state.evidenceRefs, []);
  assert.equal(result.state.attempts.implementation, state.attempts.implementation);
  assert.equal(result.state.lastReason, 'remote-head-drift');
});

test('checkpoint cannot attach stale checks/findings/classifier to the current material head', () => {
  const state = createPersistentDeliveryState(stateInput());

  assert.throws(() => applyPersistentCheckpoint(state, {
    transitionId: 'stale-check',
    observed: observed(),
    workflowChecks: [{
      name: 'Validate repository',
      subjectSha: SHA_B,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 1002,
      evidenceRef: 'github:check/1002'
    }]
  }), /stale for material head/);

  assert.throws(() => applyPersistentCheckpoint(state, {
    transitionId: 'stale-classifier',
    observed: observed(),
    classifier: {
      subjectSha: SHA_B,
      version: 'v2',
      fingerprint: 'stale-fp'
    }
  }), /classifier must apply to the observed material head/);
});

test('persisted state cannot be resumed against a different repository, PR, or head ref', () => {
  const state = createPersistentDeliveryState(stateInput());

  assert.throws(() => reconcilePersistentState(state, observed(SHA_A, { repository: 'other/repo' })), /repository does not match/);
  assert.throws(() => reconcilePersistentState(state, observed(SHA_A, { pullRequestNumber: 99 })), /PR does not match/);
  assert.throws(() => reconcilePersistentState(state, observed(SHA_A, { headRef: 'other/head' })), /headRef does not match/);
});

test('resume API derives next action from persisted status without conversational reconstruction', () => {
  const state = createPersistentDeliveryState(stateInput({ status: 'audit-pending' }));
  const result = reconcilePersistentState(state, observed());

  assert.equal(result.staleStateDetected, false);
  assert.equal(result.nextAction, 'run-audit');
  assert.deepEqual(result.state, state);
});

test('resume API persists remote-head reconciliation so the next process sees the fresher SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dv2-resume-'));
  const filePath = join(dir, 'state.json');
  await savePersistentDeliveryState(filePath, createPersistentDeliveryState(stateInput({ status: 'ready-for-human-merge' })));

  const first = await resumePersistentDelivery({ filePath, observed: observed(SHA_B) });
  assert.equal(first.staleStateDetected, true);
  assert.equal(first.state.materialHeadSha, SHA_B);

  const second = await resumePersistentDelivery({ filePath, observed: observed(SHA_B) });
  assert.equal(second.staleStateDetected, false);
  assert.equal(second.state.materialHeadSha, SHA_B);
  assert.equal(second.nextAction, 'classify');
});

test('a checkpoint observing head drift records the transition only after remote reconciliation', () => {
  const state = createPersistentDeliveryState(stateInput({ status: 'audit-pending' }));
  const next = applyPersistentCheckpoint(state, {
    transitionId: 'remote-drift:b',
    observed: observed(SHA_B),
    status: 'ready-for-human-merge'
  });

  assert.equal(next.materialHeadSha, SHA_B);
  assert.equal(next.status, 'queued');
  assert.equal(next.lastReason, 'remote-head-drift');
  assert.deepEqual(next.appliedTransitionIds, ['remote-drift:b']);
});


test('base drift invalidates candidate-bound evidence even when the material head is unchanged', () => {
  const state = createPersistentDeliveryState(stateInput({
    status: 'ready-for-human-merge',
    workflowChecks: [{ name: 'Validate repository', subjectSha: SHA_A, status: 'completed', conclusion: 'success', workflowRunId: 1001, evidenceRef: 'github:check/1001' }],
    evidenceRefs: ['github:check/1001']
  }));
  const nextBase = 'd'.repeat(40);
  const result = reconcilePersistentState(state, observed(SHA_A, { baseSha: nextBase }));
  assert.equal(result.staleStateDetected, true);
  assert.equal(result.nextAction, 'classify');
  assert.equal(result.state.baseSha, nextBase);
  assert.equal(result.state.materialHeadSha, SHA_A);
  assert.equal(result.state.status, 'queued');
  assert.deepEqual(result.state.workflowChecks, []);
  assert.deepEqual(result.state.evidenceRefs, []);
  assert.equal(result.state.lastReason, 'remote-base-drift');
});