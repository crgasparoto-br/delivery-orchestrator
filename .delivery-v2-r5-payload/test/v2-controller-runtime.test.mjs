import assert from 'node:assert/strict';
import test from 'node:test';
import { ciFailureClassForEvidence, expectedDispatchTitle, mergePreviewEvidenceFromWorkflow, releaseIdentityFromPullRequest, selectCorrelatedWorkflowRun, validateAuditArtifactPayload } from '../src/v2/controller-runtime.mjs';

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


test('release identity never fabricates merge-preview validation from GitHub mergeability', () => {
  const baseSha = 'c'.repeat(40);
  const previewSha = 'd'.repeat(40);
  const pr = { number: 64, html_url: 'https://github.com/owner/target/pull/64', head: { sha: SHA }, base: { sha: baseSha }, merge_commit_sha: previewSha, mergeable: true };
  const identity = releaseIdentityFromPullRequest(pr, { materialHeadSha: SHA, baseSha });
  assert.equal(identity.currentBaseSha, baseSha);
  assert.equal(identity.mergePreview.previewSha, previewSha);
  assert.equal(identity.mergePreview.status, 'pending');
  assert.equal(identity.mergePreview.conclusion, null);
  assert.throws(() => releaseIdentityFromPullRequest({ ...pr, base: { sha: 'e'.repeat(40) } }, { materialHeadSha: SHA, baseSha }), /base drift/);
});

test('merge-preview release evidence requires a successful named job from the exact PR/head/base workflow run', () => {
  const baseSha = 'c'.repeat(40);
  const previewSha = 'd'.repeat(40);
  const pr = { number: 64, html_url: 'https://github.com/owner/target/pull/64', head: { sha: SHA }, base: { sha: baseSha }, merge_commit_sha: previewSha };
  const run = { id: 10, event: 'pull_request', head_sha: SHA, html_url: 'run:10', pull_requests: [{ number: 64, head: { sha: SHA }, base: { sha: baseSha } }] };
  const evidence = mergePreviewEvidenceFromWorkflow({ pullRequest: pr, materialHeadSha: SHA, baseSha, workflowRun: run, jobs: [{ id: 1, name: 'Merge preview compatibility', status: 'completed', conclusion: 'success', html_url: 'job:1' }], requiredJobName: 'Merge preview compatibility', jobLogById: { 1: `checkout refs/pull/64/merge ${previewSha}` } });
  assert.equal(evidence.previewSha, previewSha);
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.conclusion, 'success');
  assert.equal(evidence.evidenceRef, 'job:1');
  const missing = mergePreviewEvidenceFromWorkflow({ pullRequest: pr, materialHeadSha: SHA, baseSha, workflowRun: run, jobs: [], requiredJobName: 'Merge preview compatibility' });
  assert.equal(missing.status, 'pending');
  const unbound = mergePreviewEvidenceFromWorkflow({ pullRequest: pr, materialHeadSha: SHA, baseSha, workflowRun: run, jobs: [{ id: 2, name: 'Merge preview compatibility', status: 'completed', conclusion: 'success', html_url: 'job:2' }], requiredJobName: 'Merge preview compatibility', jobLogById: { 2: 'checkout unrelated-ref' } });
  assert.equal(unbound.status, 'pending');
  assert.throws(() => mergePreviewEvidenceFromWorkflow({ pullRequest: pr, materialHeadSha: SHA, baseSha, workflowRun: { ...run, head_sha: 'e'.repeat(40) }, jobs: [], requiredJobName: 'Merge preview compatibility' }), /head mismatch/);
});
