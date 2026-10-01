import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createPersistentDeliveryState,
  reconcilePersistentState
} from '../src/v2/persistent-state.mjs';

const MATERIAL = 'a'.repeat(40);
const POST_HANDOFF_MATERIAL = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

test('post-handoff material drift invalidates candidate-bound readiness and evidence', () => {
  const state = createPersistentDeliveryState({
    repository: 'acme/example',
    issueNumber: 301,
    pullRequestNumber: 302,
    baseRef: 'main',
    baseSha: BASE,
    headRef: 'fix/example',
    materialHeadSha: MATERIAL,
    effectiveRisk: 'critical',
    classifier: {
      subjectSha: MATERIAL,
      version: 'v2',
      fingerprint: 'classifier-fp'
    },
    provider: 'codex',
    status: 'ready-for-human-merge',
    attempts: { implementation: 1, audit: 1, auditRemediation: 0 },
    workflowChecks: [{
      name: 'Validate repository',
      subjectSha: MATERIAL,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 1001,
      evidenceRef: 'github:check/1001'
    }],
    auditEvidence: {
      candidateSha: MATERIAL,
      decision: 'approved',
      evidenceRef: 'github:audit/1002'
    },
    blockingFindings: [],
    evidenceRefs: ['github:check/1001', 'github:audit/1002'],
    lastReason: 'audit-approved'
  });

  const result = reconcilePersistentState(state, {
    repository: 'acme/example',
    pullRequestNumber: 302,
    headRef: 'fix/example',
    baseSha: BASE,
    remoteHeadSha: POST_HANDOFF_MATERIAL
  });

  assert.equal(result.staleStateDetected, true);
  assert.equal(result.nextAction, 'classify');
  assert.equal(result.state.materialHeadSha, POST_HANDOFF_MATERIAL);
  assert.equal(result.state.status, 'queued');
  assert.equal(result.state.classifier.current, false);
  assert.deepEqual(result.state.workflowChecks, []);
  assert.equal(result.state.auditEvidence, null);
  assert.deepEqual(result.state.evidenceRefs, []);
  assert.equal(result.state.lastReason, 'remote-head-drift');
});

test('canonical contract forbids handoff-only recovery after post-handoff material writes', async () => {
  const spec = await readFile(new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url), 'utf8');

  assert.match(spec, /published handoff SHA separately from a fresh remote HEAD observation/);
  assert.match(spec, /material_dirty_since_freeze/);
  assert.match(spec, /requires `post-write-refreeze`/);
  assert.match(spec, /`handoff-stale` alone must never downgrade this recovery to `handoff-only`/);
});
