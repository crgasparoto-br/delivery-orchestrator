import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertTargetPullRequest,
  assertTargetSourceWorkflow,
  buildTargetCriticalAuditRequest,
  normalizeTargetAuditConfig
} from '../src/v2/target-independent-audit-runtime.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const CANDIDATE_BLOB = 'd'.repeat(40);
const BASE_BLOB = 'e'.repeat(40);
const REPOSITORY = 'example-org/training-system';

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'training-system-435',
    repository: REPOSITORY,
    issueNumber: 431,
    pullRequestNumber: 435,
    baseRef: 'develop',
    baseSha: BASE,
    headRef: 'ci/431-delivery-v2-adaptive-gate',
    materialHeadSha: HEAD,
    mergeCommitSha: MERGE,
    classifierPath: '.delivery-v2/risk-profile.mjs',
    sourceWorkflow: {
      runId: 9001,
      workflowId: 7001,
      name: 'Validate PR',
      path: '.github/workflows/validate-pr.yml',
      event: 'pull_request'
    },
    purpose: 'historical target audit',
    ...overrides
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 435,
    state: 'closed',
    merged: true,
    merge_commit_sha: MERGE,
    user: { login: 'implementer-user' },
    base: { ref: 'develop', sha: BASE, repo: { full_name: REPOSITORY } },
    head: { ref: 'ci/431-delivery-v2-adaptive-gate', sha: HEAD, repo: { full_name: REPOSITORY } },
    ...overrides
  };
}

function greenRun(overrides = {}) {
  return {
    id: 9001,
    workflow_id: 7001,
    name: 'Validate PR',
    path: '.github/workflows/validate-pr.yml',
    event: 'pull_request',
    repository: { full_name: REPOSITORY },
    head_branch: 'ci/431-delivery-v2-adaptive-gate',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [],
    ...overrides
  };
}

function definition(overrides = {}) {
  return {
    id: 7001,
    name: 'Validate PR',
    path: '.github/workflows/validate-pr.yml',
    state: 'active',
    ...overrides
  };
}

const candidateWorkflow = {
  ref: HEAD,
  path: '.github/workflows/validate-pr.yml',
  blobSha: CANDIDATE_BLOB,
  content: 'name: Validate PR\non: pull_request\njobs:\n  adaptive: {}\n'
};
const baseWorkflow = {
  ref: BASE,
  path: '.github/workflows/validate-pr.yml',
  blobSha: BASE_BLOB,
  content: 'name: Validate PR\non: pull_request\njobs:\n  full: {}\n'
};

test('target audit config binds immutable historical PR and source-CI identity', () => {
  const normalized = normalizeTargetAuditConfig(config());
  assert.equal(normalized.id, 'training-system-435');
  assert.equal(normalized.repository, REPOSITORY);
  assert.equal(normalized.materialHeadSha, HEAD);
  assert.equal(normalized.sourceWorkflow.runId, 9001);
  assert.equal(assertTargetPullRequest(normalized, pullRequest()).pullRequest.number, 435);
  assert.throws(() => assertTargetPullRequest(normalized, pullRequest({ merge_commit_sha: HEAD })), /merge commit/);
  assert.throws(() => assertTargetPullRequest(normalized, pullRequest({ head: { ref: 'other', sha: HEAD, repo: { full_name: REPOSITORY } } })), /head ref/);
});

test('historical workflow run may have empty PR associations but cannot carry a conflicting one', () => {
  const resolved = assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition());
  assert.equal(resolved.run.id, 9001);
  assert.deepEqual(resolved.run.pull_requests, []);
  assert.throws(
    () => assertTargetSourceWorkflow(config(), pullRequest(), greenRun({ pull_requests: [{ number: 999 }] }), definition()),
    /conflicting pull request association/
  );
  assert.throws(
    () => assertTargetSourceWorkflow(config(), pullRequest(), greenRun({ head_sha: BASE }), definition()),
    /stale for target candidate/
  );
  assert.throws(
    () => assertTargetSourceWorkflow(config(), pullRequest(), greenRun({ conclusion: 'failure' }), definition()),
    /terminal green/
  );
});

test('target CRITICAL request treats candidate-owned CI as evidence under review, not as trusted workflow bytes', () => {
  const request = buildTargetCriticalAuditRequest({
    config: config(),
    pullRequest: pullRequest(),
    changedPaths: ['.github/workflows/validate-pr.yml', '.delivery-v2/risk-profile.mjs'],
    sourceWorkflowRun: greenRun(),
    sourceWorkflowDefinition: definition(),
    candidateWorkflowEvidence: candidateWorkflow,
    baseWorkflowEvidence: baseWorkflow,
    classifierSource: 'export const classifier = true;\n'
  });

  assert.equal(request.candidate.materialHeadSha, HEAD);
  assert.equal(request.candidate.baseSha, BASE);
  assert.equal(request.candidate.risk.profile, 'critical');
  assert.equal(request.applicability.mode, 'independent');
  assert.equal(request.targetAudit.sourceCiTrust, 'candidate-workflow-under-independent-review');
  assert.equal(request.targetAudit.sourceWorkflow.candidateDiffersFromBase, true);
  assert.equal(request.targetAudit.sourceWorkflow.candidate.blobSha, CANDIDATE_BLOB);
  assert.equal(request.targetAudit.sourceWorkflow.trustedBase.blobSha, BASE_BLOB);
  assert.equal(request.targetAudit.sourceWorkflow.pullRequestAssociationsObserved, 0);
  assert.equal(request.candidate.checks[0].workflowEvidence.blobSha, BASE_BLOB);
  assert.match(request.requestFingerprint, /^[0-9a-f]{64}$/);
});

test('configured training-system audit freezes the canonical DV2-013 historical identity', async () => {
  const raw = JSON.parse(await readFile(new URL('../config/delivery-v2-target-audits/training-system-435.json', import.meta.url), 'utf8'));
  const normalized = normalizeTargetAuditConfig(raw);
  assert.equal(normalized.repository, 'crgasparoto-br/training-system');
  assert.equal(normalized.pullRequestNumber, 435);
  assert.equal(normalized.materialHeadSha, 'ae0fade7be03c6c66f00fbd605bd85d9259aa622');
  assert.equal(normalized.baseSha, 'b2952652539998708e3ae5fc74cadd7fa68e98fe');
  assert.equal(normalized.mergeCommitSha, '0fba4d2870e087775433b844e22f04c0daa84bcf');
  assert.equal(normalized.sourceWorkflow.runId, 34664164768);
  assert.equal(normalized.sourceWorkflow.workflowId, 277560379);
});

test('target audit workflow preserves isolated reviewer and controller write-token boundary', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../scripts/run-delivery-v2-target-independent-audit.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /DV2-TARGET-AUDIT:/);
  assert.match(workflow, /Independent target CRITICAL semantic audit/);
  assert.match(workflow, /TARGET_AUDIT_ID/);
  assert.match(workflow, /run-delivery-v2-target-independent-audit\.mjs/);
  assert.equal((workflow.match(/DELIVERY_GITHUB_WRITE_TOKEN/g) || []).length, 1);
  assert.doesNotMatch(runner, /DELIVERY_GITHUB_WRITE_TOKEN/);
  assert.match(runner, /sandboxMode: 'read-only'/);
  assert.match(runner, /networkAccessEnabled: false/);
  assert.match(runner, /SOURCE_WORKFLOW_BASE\.yml/);
  assert.match(runner, /SOURCE_WORKFLOW_CANDIDATE\.yml/);
  assert.match(runner, /candidate changed its own source CI workflow/);
  assert.doesNotMatch(runner, /handoff-ready\.json/);
});
