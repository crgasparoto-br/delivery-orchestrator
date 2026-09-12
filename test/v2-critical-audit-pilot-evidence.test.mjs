import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAuditInput } from '../src/v2/audit-contract.mjs';
import { buildGithubNativeCriticalAuditRequest } from '../src/v2/independent-audit-runtime.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const BLOB = 'd'.repeat(40);
const REPOSITORY = 'example-org/delivery-orchestrator';
const REPOSITORY_ID = 424242;
const WORKFLOW_ID = 355818772;
const WORKFLOW_PATH = '.github/workflows/delivery-v2-ci.yml';
const WORKFLOW_SOURCE = 'name: Delivery V2 CI\non:\n  pull_request:\n';

test('CRITICAL audit evidence survives serialization and cannot be stripped before review', () => {
  const pullRequest = {
    number: 48,
    body: 'DV2-AUDIT-PILOT: critical',
    user: { login: 'implementer-user' },
    base: { ref: 'main', sha: B, repo: { id: REPOSITORY_ID, full_name: REPOSITORY } },
    head: { ref: 'test/dv2-audit-pilot', sha: A, repo: { id: REPOSITORY_ID, full_name: REPOSITORY } },
    merge_commit_sha: M
  };
  const sourceWorkflowRun = {
    id: 9001,
    name: 'Delivery V2 CI',
    workflow_id: WORKFLOW_ID,
    path: WORKFLOW_PATH,
    event: 'pull_request',
    repository: { full_name: REPOSITORY },
    head_branch: pullRequest.head.ref,
    head_sha: A,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [{
      number: pullRequest.number,
      head: { ref: pullRequest.head.ref, sha: A, repo: { id: REPOSITORY_ID } },
      base: { ref: pullRequest.base.ref, sha: B, repo: { id: REPOSITORY_ID } }
    }]
  };
  const sourceWorkflowDefinition = {
    id: WORKFLOW_ID,
    name: 'Delivery V2 CI',
    path: WORKFLOW_PATH,
    state: 'active'
  };
  const sourceWorkflowEvidence = {
    candidate: { ref: A, path: WORKFLOW_PATH, blobSha: BLOB, content: WORKFLOW_SOURCE },
    trustedBase: { ref: B, path: WORKFLOW_PATH, blobSha: BLOB, content: WORKFLOW_SOURCE }
  };

  const request = buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest,
    changedPaths: ['test/v2-critical-audit-pilot-evidence.test.mjs'],
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowEvidence,
    classifierSource: 'classifier'
  });

  const serializedCandidate = JSON.parse(JSON.stringify(request.candidate));
  assert.equal(normalizeAuditInput(serializedCandidate).checks[0].workflowEvidence.workflowId, WORKFLOW_ID);

  delete serializedCandidate.checks[0].workflowEvidence;
  assert.throws(() => normalizeAuditInput(serializedCandidate), /workflowEvidence must be an object/);
});
