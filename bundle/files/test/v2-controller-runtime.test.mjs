import assert from 'node:assert/strict';
import test from 'node:test';
import { ciFailureClassForConclusion, expectedDispatchTitle, selectCorrelatedWorkflowRun, validateAuditArtifactPayload } from '../src/v2/controller-runtime.mjs';

const SHA = 'a'.repeat(40);

test('workflow dispatch correlation requires exact nonce title and trusted ref', () => {
  const nonce = 'n-123';
  const run = { id: 7, event: 'workflow_dispatch', display_title: expectedDispatchTitle('audit', nonce), head_branch: 'main' };
  assert.equal(selectCorrelatedWorkflowRun([run], { kind: 'audit', nonce, ref: 'main' }).id, 7);
  assert.equal(selectCorrelatedWorkflowRun([{ ...run, display_title: 'other' }], { kind: 'audit', nonce, ref: 'main' }), null);
  assert.equal(selectCorrelatedWorkflowRun([{ ...run, head_branch: 'feature' }], { kind: 'audit', nonce, ref: 'main' }), null);
});

test('external CI conclusions never become actionable remediation', () => {
  assert.equal(ciFailureClassForConclusion('failure'), 'actionable');
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'stale', 'neutral', 'skipped']) assert.equal(ciFailureClassForConclusion(conclusion), 'external');
});

test('authoritative audit artifact is exact-run exact-head and fingerprint bound', () => {
  const fp = 'b'.repeat(64);
  const payload = {
    repository: 'owner/target', issueNumber: 63, pullRequestNumber: 64, sourceWorkflowRunId: 10, auditWorkflowRunId: 20,
    request: { requestFingerprint: fp, candidate: { materialHeadSha: SHA } },
    result: { candidateSha: SHA, requestFingerprint: fp, reviewer: { runId: 20, contextIsolation: 'candidate-contract-evidence-only', workerIdentity: 'delivery-v2-github-native-auditor' }, decision: 'approved', findings: [] }
  };
  assert.equal(validateAuditArtifactPayload(payload, { orchestratorRepository: 'owner/orchestrator', targetRepository: 'owner/target', issueNumber: 63, pullRequestNumber: 64, candidateSha: SHA, auditRunId: 20, sourceWorkflowRunId: 10 }).decision, 'approved');
  assert.throws(() => validateAuditArtifactPayload({ ...payload, result: { ...payload.result, candidateSha: 'c'.repeat(40) } }, { orchestratorRepository: 'owner/orchestrator', targetRepository: 'owner/target', issueNumber: 63, pullRequestNumber: 64, candidateSha: SHA, auditRunId: 20, sourceWorkflowRunId: 10 }), /candidate mismatch/);
});
