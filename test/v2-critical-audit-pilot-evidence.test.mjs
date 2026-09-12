import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuditRequest, normalizeAuditInput } from '../src/v2/audit-contract.mjs';
import {
  assertTrustedSourceWorkflowRun,
  buildGithubNativeCriticalAuditRequest,
  fingerprintWorkflowSource
} from '../src/v2/independent-audit-runtime.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const BLOB = 'd'.repeat(40);
const OTHER_BLOB = 'e'.repeat(40);
const REPOSITORY = 'example-org/delivery-orchestrator';
const REPOSITORY_ID = 424242;
const WORKFLOW_ID = 355818772;
const RUN_ID = 9001;
const WORKFLOW_PATH = '.github/workflows/delivery-v2-ci.yml';
const WORKFLOW_SOURCE = 'name: Delivery V2 CI\non:\n  pull_request:\n';

function pullRequest(overrides = {}) {
  return {
    number: 48,
    body: 'DV2-AUDIT-PILOT: critical',
    user: { login: 'implementer-user' },
    base: { ref: 'main', sha: B, repo: { id: REPOSITORY_ID, full_name: REPOSITORY } },
    head: { ref: 'test/dv2-audit-pilot', sha: A, repo: { id: REPOSITORY_ID, full_name: REPOSITORY } },
    merge_commit_sha: M,
    ...overrides
  };
}

function sourceRun(overrides = {}) {
  return {
    id: RUN_ID,
    name: 'Delivery V2 CI',
    workflow_id: WORKFLOW_ID,
    path: WORKFLOW_PATH,
    event: 'pull_request',
    repository: { full_name: REPOSITORY },
    head_branch: 'test/dv2-audit-pilot',
    head_sha: A,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [{
      number: 48,
      head: { ref: 'test/dv2-audit-pilot', sha: A, repo: { id: REPOSITORY_ID } },
      base: { ref: 'main', sha: B, repo: { id: REPOSITORY_ID } }
    }],
    ...overrides
  };
}

function sourceDefinition(overrides = {}) {
  return { id: WORKFLOW_ID, name: 'Delivery V2 CI', path: WORKFLOW_PATH, state: 'active', ...overrides };
}

function sourceEvidence(overrides = {}) {
  return {
    candidate: { ref: A, path: WORKFLOW_PATH, blobSha: BLOB, content: WORKFLOW_SOURCE },
    trustedBase: { ref: B, path: WORKFLOW_PATH, blobSha: BLOB, content: WORKFLOW_SOURCE },
    ...overrides
  };
}

function buildRequest(overrides = {}) {
  return buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pullRequest(),
    changedPaths: ['test/v2-critical-audit-pilot-evidence.test.mjs'],
    sourceWorkflowRun: sourceRun(),
    sourceWorkflowDefinition: sourceDefinition(),
    sourceWorkflowEvidence: sourceEvidence(),
    classifierSource: 'classifier',
    ...overrides
  });
}

function assertSourceRejected({ pr = pullRequest(), run = sourceRun(), definition = sourceDefinition(), evidence = sourceEvidence() }, pattern) {
  assert.throws(
    () => assertTrustedSourceWorkflowRun(run, REPOSITORY, pr, definition, evidence),
    pattern
  );
}

test('CRITICAL audit request preserves all trusted identity and workflow provenance through serialization', () => {
  const request = buildRequest();
  const serialized = JSON.parse(JSON.stringify(request));
  const candidate = normalizeAuditInput(serialized.candidate);
  const check = candidate.checks[0];

  assert.equal(candidate.repository, REPOSITORY);
  assert.equal(candidate.pullRequestNumber, 48);
  assert.equal(candidate.baseRef, 'main');
  assert.equal(candidate.baseSha, B);
  assert.equal(candidate.headRef, 'test/dv2-audit-pilot');
  assert.equal(candidate.materialHeadSha, A);
  assert.equal(check.workflowRunId, RUN_ID);
  assert.deepEqual(check.workflowEvidence, {
    workflowId: WORKFLOW_ID,
    path: WORKFLOW_PATH,
    state: 'active',
    trustedBaseSha: B,
    blobSha: BLOB,
    fingerprint: fingerprintWorkflowSource(WORKFLOW_SOURCE)
  });
  assert.equal(serialized.requestFingerprint, request.requestFingerprint);
});

test('trusted source rejects every independently mutated PR/head/base/repository identity', () => {
  assertSourceRejected({ run: sourceRun({ head_branch: 'other-branch' }) }, /head_branch/);
  assertSourceRejected({ run: sourceRun({ head_sha: B }) }, /stale/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], number: 49 }] }) }, /pull request number/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], head: { ...sourceRun().pull_requests[0].head, ref: 'other-branch' } }] }) }, /head ref/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], head: { ...sourceRun().pull_requests[0].head, sha: B } }] }) }, /head SHA/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], head: { ...sourceRun().pull_requests[0].head, repo: { id: REPOSITORY_ID + 1 } } }] }) }, /head repository id/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], base: { ...sourceRun().pull_requests[0].base, ref: 'release' } }] }) }, /base ref/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], base: { ...sourceRun().pull_requests[0].base, sha: A } }] }) }, /base SHA/);
  assertSourceRejected({ run: sourceRun({ pull_requests: [{ ...sourceRun().pull_requests[0], base: { ...sourceRun().pull_requests[0].base, repo: { id: REPOSITORY_ID + 1 } } }] }) }, /base repository id/);
  assertSourceRejected({ run: sourceRun({ repository: { full_name: 'attacker/fork' } }) }, /source workflow repository/);
});

test('trusted source rejects every independently mutated workflow identity or provenance field', () => {
  assertSourceRejected({ run: sourceRun({ workflow_id: WORKFLOW_ID + 1 }) }, /workflow_id/);
  assertSourceRejected({ run: sourceRun({ path: '.github/workflows/lookalike.yml' }) }, /source workflow run must use/);
  assertSourceRejected({ run: sourceRun({ event: 'push' }) }, /source workflow event/);
  assertSourceRejected({ run: sourceRun({ conclusion: 'failure' }) }, /terminal green/);
  assertSourceRejected({ definition: sourceDefinition({ path: '.github/workflows/lookalike.yml' }) }, /resolved workflow definition must use/);
  assertSourceRejected({ definition: sourceDefinition({ state: undefined }) }, /state is required/);
  assertSourceRejected({ definition: sourceDefinition({ state: 'disabled_manually' }) }, /must be active/);
  assertSourceRejected({ evidence: sourceEvidence({ candidate: { ref: B, path: WORKFLOW_PATH, blobSha: BLOB, content: WORKFLOW_SOURCE } }) }, /candidate workflow ref/);
  assertSourceRejected({ evidence: sourceEvidence({ trustedBase: { ref: A, path: WORKFLOW_PATH, blobSha: BLOB, content: WORKFLOW_SOURCE } }) }, /trusted workflow ref/);
  assertSourceRejected({ evidence: sourceEvidence({ candidate: { ref: A, path: WORKFLOW_PATH, blobSha: OTHER_BLOB, content: WORKFLOW_SOURCE } }) }, /trusted base workflow blob/);
  assertSourceRejected({ evidence: sourceEvidence({ candidate: { ref: A, path: WORKFLOW_PATH, blobSha: BLOB, content: `${WORKFLOW_SOURCE}jobs: {}\n` } }) }, /fingerprint does not match/);
});

test('audit request rejects an invalid source workflow run id at the check-evidence boundary', () => {
  assert.throws(
    () => buildRequest({ sourceWorkflowRun: sourceRun({ id: 0 }) }),
    /sourceWorkflowRun\.id must be a positive integer/
  );
});

test('serialized authoritative evidence fails closed when mandatory fields are stripped or corrupted', () => {
  const candidate = JSON.parse(JSON.stringify(buildRequest().candidate));
  const evidence = candidate.checks[0].workflowEvidence;

  const mutations = [
    { label: 'whole evidence', mutate: (value) => { delete value.checks[0].workflowEvidence; }, pattern: /workflowEvidence must be an object/ },
    { label: 'workflow id', mutate: (value) => { value.checks[0].workflowEvidence.workflowId = 0; }, pattern: /workflowId must be a positive integer/ },
    { label: 'path', mutate: (value) => { value.checks[0].workflowEvidence.path = ''; }, pattern: /workflowEvidence.path is required/ },
    { label: 'state', mutate: (value) => { value.checks[0].workflowEvidence.state = 'disabled'; }, pattern: /state must be active/ },
    { label: 'trusted base', mutate: (value) => { value.checks[0].workflowEvidence.trustedBaseSha = A; }, pattern: /does not match audit baseSha/ },
    { label: 'blob', mutate: (value) => { value.checks[0].workflowEvidence.blobSha = 'not-a-sha'; }, pattern: /40-character Git commit SHA/ },
    { label: 'fingerprint', mutate: (value) => { value.checks[0].workflowEvidence.fingerprint = 'not-a-sha256'; }, pattern: /64-character SHA-256/ },
    { label: 'run id', mutate: (value) => { value.checks[0].workflowRunId = 0; }, pattern: /workflowRunId must be a positive integer/ }
  ];

  for (const mutation of mutations) {
    const value = JSON.parse(JSON.stringify(candidate));
    mutation.mutate(value);
    assert.throws(() => normalizeAuditInput(value), mutation.pattern, mutation.label);
  }

  assert.equal(evidence.trustedBaseSha, B);
});

test('any valid evidence change produces a different exact request fingerprint', () => {
  const request = buildRequest();
  const changed = JSON.parse(JSON.stringify(request.candidate));
  changed.checks[0].workflowEvidence.path = '.github/workflows/another-trusted-path.yml';
  const changedRequest = buildAuditRequest(changed);
  assert.notEqual(changedRequest.requestFingerprint, request.requestFingerprint);
});
