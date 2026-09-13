import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTrustedAuditPullRequest,
  buildGithubNativeAuditRequest,
  finalizeGithubNativeAuditResult,
  fingerprintSource
} from '../src/v2/github-native-audit-runtime.mjs';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const W = 'd'.repeat(40);
const REPO = 'owner/product';
const PATH = '.github/workflows/validate-pr.yml';
const SOURCE = 'name: Validate PR\non: pull_request\n';

function pr(overrides = {}) {
  return {
    number: 77, user: { login: 'worker' }, merge_commit_sha: M,
    head: { ref: 'feat/63', sha: H, repo: { full_name: REPO } },
    base: { ref: 'develop', sha: B, repo: { full_name: REPO } },
    ...overrides
  };
}
function run(overrides = {}) {
  return { id: 9, workflow_id: 11, name: 'Validate PR', path: PATH, event: 'pull_request', repository: { full_name: REPO }, head_sha: H, status: 'completed', conclusion: 'success', ...overrides };
}
const definition = { id: 11, name: 'Validate PR', path: PATH, state: 'active' };
const evidence = {
  candidate: { ref: H, path: PATH, blobSha: W, content: SOURCE },
  trustedBase: { ref: B, path: PATH, blobSha: W, content: SOURCE }
};

function request(riskProfile = 'critical') {
  return buildGithubNativeAuditRequest({
    repository: REPO,
    issueNumber: 63,
    pullRequest: pr(),
    changedPaths: ['src/service.ts'],
    riskProfile,
    riskReasons: ['repository-critical-root:src'],
    classifier: { version: 'source@abc', fingerprint: fingerprintSource('classifier') },
    sourceWorkflowRun: run(),
    sourceWorkflowDefinition: definition,
    sourceWorkflowEvidence: evidence,
    workflowName: 'Validate PR',
    workflowPath: PATH,
    implementer: { provider: 'codex', workerIdentity: 'delivery-v2-worker-codex-critical.md', runId: 1234 },
    priorFindings: [{ id: 'DV2-OLD-FINDING', candidateSha: 'e'.repeat(40), status: 'remediated-pending-verification' }]
  });
}

test('generic auditor accepts a same-repository PR without a pilot marker', () => {
  assert.equal(assertTrustedAuditPullRequest(pr({ body: 'ordinary Delivery V2 PR' }), REPO).number, 77);
});

test('generic audit request binds target workflow, exact SHA and requested effective risk', () => {
  const value = request('critical');
  assert.equal(value.candidate.materialHeadSha, H);
  assert.equal(value.candidate.risk.profile, 'critical');
  assert.equal(value.candidate.checks[0].name, 'Validate PR');
  assert.equal(value.candidate.checks[0].workflowEvidence.path, PATH);
  assert.equal(value.candidate.implementer.provider, 'codex');
  assert.equal(value.candidate.implementer.workerIdentity, 'delivery-v2-worker-codex-critical.md');
  assert.equal(value.candidate.implementer.runId, 1234);
  assert.equal(value.candidate.priorFindings.length, 1);
  assert.equal(value.candidate.priorFindings[0].id, 'DV2-OLD-FINDING');
  assert.equal(value.candidate.priorFindings[0].sameCandidate, false);
  assert.equal(value.applicability.mode, 'independent');
});

test('generic audit fails closed when candidate changes the trusted CI workflow', () => {
  assert.throws(() => buildGithubNativeAuditRequest({
    repository: REPO,
    issueNumber: 63,
    pullRequest: pr(),
    changedPaths: ['src/service.ts'],
    riskProfile: 'critical',
    classifier: { version: 'v1', fingerprint: fingerprintSource('classifier') },
    sourceWorkflowRun: run(), sourceWorkflowDefinition: definition,
    sourceWorkflowEvidence: { ...evidence, candidate: { ...evidence.candidate, blobSha: 'e'.repeat(40), content: `${SOURCE}jobs: {}` } },
    workflowName: 'Validate PR', workflowPath: PATH
  }), /differs from trusted base/);
});

test('final result preserves independent exact-head outcome', () => {
  const auditRequest = request('critical');
  const finalized = finalizeGithubNativeAuditResult({ request: auditRequest, reviewerRunId: 10, modelResult: { decision: 'approved', findings: [] } });
  assert.equal(finalized.result.candidateSha, H);
  assert.equal(finalized.result.reviewer.contextIsolation, 'candidate-contract-evidence-only');
  assert.equal(finalized.outcome.status, 'approved');
});
