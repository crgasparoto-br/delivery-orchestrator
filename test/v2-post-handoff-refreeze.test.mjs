import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyPersistentCheckpoint,
  createPersistentDeliveryState,
  reconcilePersistentState
} from '../src/v2/persistent-state.mjs';

const MATERIAL = 'a'.repeat(40);
const POST_HANDOFF_MATERIAL = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

function readyState() {
  return createPersistentDeliveryState({
    repository: 'acme/example',
    issueNumber: 41,
    pullRequestNumber: 42,
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
}

test('post-handoff material drift invalidates candidate-bound readiness and evidence', () => {
  const result = reconcilePersistentState(readyState(), {
    repository: 'acme/example',
    pullRequestNumber: 42,
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

test('post-handoff material drift requires fresh exact-head CI and a fresh independent audit before readiness', () => {
  const reconciled = reconcilePersistentState(readyState(), {
    repository: 'acme/example',
    pullRequestNumber: 42,
    headRef: 'fix/example',
    baseSha: BASE,
    remoteHeadSha: POST_HANDOFF_MATERIAL
  }).state;

  assert.throws(
    () => applyPersistentCheckpoint(reconciled, {
      transitionId: 'reuse-old-audit',
      observed: {
        repository: 'acme/example',
        pullRequestNumber: 42,
        headRef: 'fix/example',
        baseSha: BASE,
        remoteHeadSha: POST_HANDOFF_MATERIAL
      },
      classifier: {
        subjectSha: MATERIAL,
        version: 'v2',
        fingerprint: 'stale-classifier'
      },
      auditEvidence: {
        candidateSha: MATERIAL,
        decision: 'approved',
        evidenceRef: 'github:audit/1002'
      }
    }),
    /stale|material head|classifier/i
  );

  const afterCi = applyPersistentCheckpoint(reconciled, {
    transitionId: 'fresh-ci',
    observed: {
      repository: 'acme/example',
      pullRequestNumber: 42,
      headRef: 'fix/example',
      baseSha: BASE,
      remoteHeadSha: POST_HANDOFF_MATERIAL
    },
    status: 'audit-pending',
    classifier: {
      subjectSha: POST_HANDOFF_MATERIAL,
      version: 'v2',
      fingerprint: 'classifier-fp-post-write'
    },
    workflowChecks: [{
      name: 'Validate repository',
      subjectSha: POST_HANDOFF_MATERIAL,
      status: 'completed',
      conclusion: 'success',
      workflowRunId: 2001,
      evidenceRef: 'github:check/2001'
    }],
    evidenceRefs: ['github:check/2001'],
    lastReason: 'exact-head-ci-green'
  });

  assert.equal(afterCi.status, 'audit-pending');
  assert.equal(afterCi.workflowChecks[0].subjectSha, POST_HANDOFF_MATERIAL);
  assert.equal(afterCi.auditEvidence, null);

  const afterFreshAudit = applyPersistentCheckpoint(afterCi, {
    transitionId: 'fresh-independent-audit',
    observed: {
      repository: 'acme/example',
      pullRequestNumber: 42,
      headRef: 'fix/example',
      baseSha: BASE,
      remoteHeadSha: POST_HANDOFF_MATERIAL
    },
    status: 'ready-for-human-merge',
    classifier: {
      subjectSha: POST_HANDOFF_MATERIAL,
      version: 'v2',
      fingerprint: 'classifier-fp-post-write'
    },
    auditEvidence: {
      candidateSha: POST_HANDOFF_MATERIAL,
      decision: 'approved',
      evidenceRef: 'github:audit/2002'
    },
    evidenceRefs: ['github:check/2001', 'github:audit/2002'],
    lastReason: 'fresh-audit-approved'
  });

  assert.equal(afterFreshAudit.status, 'ready-for-human-merge');
  assert.equal(afterFreshAudit.auditEvidence.candidateSha, POST_HANDOFF_MATERIAL);
  assert.notEqual(afterFreshAudit.auditEvidence.evidenceRef, 'github:audit/1002');
});

test('canonical contract requires post-write-refreeze and a fresh direct result-only child before completion', async () => {
  const spec = await readFile(new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url), 'utf8');

  assert.match(spec, /published handoff SHA separately from a fresh remote HEAD observation/);
  assert.match(spec, /compare the complete delta between them/);
  assert.match(spec, /material_dirty_since_freeze/);
  assert.match(spec, /requires `post-write-refreeze` on the current material HEAD/);
  assert.match(spec, /new direct result-only child of the refrozen material/);
  assert.match(spec, /`handoff-stale` alone must never downgrade this recovery to `handoff-only`/);
  assert.match(spec, /independent audit or release may continue/);
});
