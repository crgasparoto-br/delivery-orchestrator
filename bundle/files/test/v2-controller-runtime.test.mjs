import assert from 'node:assert/strict';
import test from 'node:test';
import { ciFailureClassForEvidence, expectedDispatchTitle, releaseIdentityFromPullRequest, selectCorrelatedWorkflowRun, validateAuditArtifactPayload } from '../src/v2/controller-runtime.mjs';

const SHA = 'a'.repeat(40);

test('workflow dispatch correlation requires exact nonce title and trusted ref', () => {
  const nonce = 'n-123';
  const run = { id: 7, event: 'workflow_dispatch', display_title: expectedDispatchTitle('audit', nonce), head_branch: 'main' };
  assert.equal(selectCorrelatedWorkflowRun([run], { kind: 'audit', nonce, ref: 'main' }).id, 7);
  assert.equal(selectCorrelatedWorkflowRun([{ ...run, display_title: 'other' }], { kind: 'audit', nonce, ref: 'main' }), null);
  assert.equal(selectCorrelatedWorkflowRun([{ ...run, head_branch: 'feature' }], { kind: 'audit', nonce, ref: 'main' }), null);
});

test('CI remediation requires explicit repository-cause evidence and fails closed on infrastructure or ambiguity', () => {
  assert.equal(ciFailureClassForEvidence({ conclusion: 'failure', failedJobs: [{ name: 'tests', failedStepNames: ['unit tests'], log: 'AssertionError: expected true to equal false' }] }), 'actionable');
  assert.equal(ciFailureClassForEvidence({ conclusion: 'failure', failedJobs: [{ name: 'tests', failedStepNames: ['unit tests'], log: 'runner lost communication; connection reset' }] }), 'external');
  assert.equal(ciFailureClassForEvidence({ conclusion: 'failure', failedJobs: [{ name: 'unknown', failedStepNames: [], log: 'Process completed with exit code 1' }] }), 'external');
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'stale', 'neutral', 'skipped']) assert.equal(ciFailureClassForEvidence({ conclusion, failedJobs: [] }), 'external');
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


test('release identity fails closed on base drift and requires a mergeable preview', () => {
  const baseSha = 'c'.repeat(40);
  const previewSha = 'd'.repeat(40);
  const pr = { number: 64, html_url: 'https://github.com/owner/target/pull/64', head: { sha: SHA }, base: { sha: baseSha }, merge_commit_sha: previewSha, mergeable: true };
  const identity = releaseIdentityFromPullRequest(pr, { materialHeadSha: SHA, baseSha });
  assert.equal(identity.currentBaseSha, baseSha);
  assert.equal(identity.mergePreview.required, true);
  assert.equal(identity.mergePreview.previewSha, previewSha);
  assert.equal(identity.mergePreview.conclusion, 'success');
  assert.throws(() => releaseIdentityFromPullRequest({ ...pr, base: { sha: 'e'.repeat(40) } }, { materialHeadSha: SHA, baseSha }), /base drift/);
  const pending = releaseIdentityFromPullRequest({ ...pr, merge_commit_sha: null, mergeable: null }, { materialHeadSha: SHA, baseSha });
  assert.equal(pending.mergePreview.status, 'pending');
  assert.equal(pending.mergePreview.conclusion, null);
});