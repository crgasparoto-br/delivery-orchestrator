import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DELIVERY_V2_CODEX_AUDITOR_IDENTITY,
  assertTrustedCriticalAuditPilot,
  assertTrustedSourceWorkflowRun,
  buildGithubNativeCriticalAuditRequest,
  finalizeIndependentAuditResult,
  fingerprintClassifierSource,
  isCriticalAuditPilot
} from '../src/v2/independent-audit-runtime.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const M = 'cccccccccccccccccccccccccccccccccccccccc';
const REPOSITORY = 'crgasparoto-br/delivery-orchestrator';
const WORKFLOW_ID = 355818772;

function pilotPr(overrides = {}) {
  return {
    number: 48,
    title: 'security(v2): bind audit evidence to trusted CI workflow',
    body: 'Exercises the GitHub-native auditor.\n\nDV2-AUDIT-PILOT: critical\n',
    user: { login: 'implementer-user' },
    base: { ref: 'main', sha: B, repo: { id: 1335971917 } },
    head: { ref: 'test/dv2-audit-pilot', sha: A, repo: { id: 1335971917, full_name: REPOSITORY } },
    merge_commit_sha: M,
    ...overrides
  };
}

function greenRun(overrides = {}) {
  return {
    id: 9001,
    name: 'Delivery V2 CI',
    workflow_id: WORKFLOW_ID,
    path: '.github/workflows/delivery-v2-ci.yml',
    event: 'pull_request',
    repository: { full_name: REPOSITORY },
    head_branch: 'test/dv2-audit-pilot',
    head_sha: A,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [{
      number: 48,
      head: { ref: 'test/dv2-audit-pilot', sha: A, repo: { id: 1335971917 } },
      base: { ref: 'main', sha: B, repo: { id: 1335971917 } }
    }],
    ...overrides
  };
}

function workflowDefinition(overrides = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Delivery V2 CI',
    path: '.github/workflows/delivery-v2-ci.yml',
    state: 'active',
    ...overrides
  };
}

function buildRequest(overrides = {}) {
  return buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pilotPr(),
    changedPaths: ['src/v2/audit-contract.mjs'],
    sourceWorkflowRun: greenRun(),
    sourceWorkflowDefinition: workflowDefinition(),
    classifierSource: 'classifier',
    ...overrides
  });
}

test('CRITICAL pilot marker is explicit and line-bound', () => {
  assert.equal(isCriticalAuditPilot(pilotPr()), true);
  assert.equal(isCriticalAuditPilot(pilotPr({ body: 'mentions DV2-AUDIT-PILOT: critical inline only' })), false);
  assert.equal(isCriticalAuditPilot(pilotPr({ body: 'DV2-AUDIT-PILOT: standard' })), false);
});

test('runtime independently enforces trusted repository origin for CRITICAL pilots', () => {
  assert.equal(assertTrustedCriticalAuditPilot(pilotPr(), REPOSITORY).number, 48);
  assert.throws(
    () => assertTrustedCriticalAuditPilot(pilotPr({ head: { ref: 'fork', sha: A, repo: { full_name: 'attacker/fork' } } }), REPOSITORY),
    /trusted repository/
  );
  assert.throws(
    () => assertTrustedCriticalAuditPilot(pilotPr({ body: 'no pilot marker' }), REPOSITORY),
    /not marked/
  );
});

test('source audit evidence binds immutable workflow id to the canonical workflow path', () => {
  assert.equal(assertTrustedSourceWorkflowRun(greenRun(), REPOSITORY, pilotPr(), workflowDefinition()).id, 9001);
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ workflow_id: WORKFLOW_ID + 1 }), REPOSITORY, pilotPr(), workflowDefinition()),
    /workflow_id/
  );
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ path: '.github/workflows/lookalike.yml' }), REPOSITORY, pilotPr(), workflowDefinition()),
    /source workflow run must use/
  );
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun(), REPOSITORY, pilotPr(), workflowDefinition({ path: '.github/workflows/lookalike.yml' })),
    /resolved workflow definition must use/
  );
});

test('source audit evidence must come from the trusted exact-head Delivery V2 CI pull-request run', () => {
  const definition = workflowDefinition();
  assert.throws(() => assertTrustedSourceWorkflowRun(greenRun({ name: 'Unrelated CI' }), REPOSITORY, pilotPr(), definition), /source workflow must be Delivery V2 CI/);
  assert.throws(() => assertTrustedSourceWorkflowRun(greenRun({ event: 'push' }), REPOSITORY, pilotPr(), definition), /source workflow event must be pull_request/);
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ repository: { full_name: 'attacker/fork' } }), REPOSITORY, pilotPr(), definition),
    /source workflow repository must be/
  );
  assert.throws(() => assertTrustedSourceWorkflowRun(greenRun({ head_sha: B }), REPOSITORY, pilotPr(), definition), /stale/);
  assert.throws(() => assertTrustedSourceWorkflowRun(greenRun({ conclusion: 'failure' }), REPOSITORY, pilotPr(), definition), /terminal green/);
});

test('source workflow is fail-closed unless it is bound to exactly the audited PR/base/head identity', () => {
  const definition = workflowDefinition();
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ pull_requests: [] }), REPOSITORY, pilotPr(), definition),
    /exactly one pull request/
  );
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ pull_requests: [greenRun().pull_requests[0], { ...greenRun().pull_requests[0], number: 49 }] }), REPOSITORY, pilotPr(), definition),
    /exactly one pull request/
  );
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ pull_requests: [{ ...greenRun().pull_requests[0], number: 49 }] }), REPOSITORY, pilotPr(), definition),
    /pull request number/
  );
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ head_branch: 'other-branch' }), REPOSITORY, pilotPr(), definition),
    /head_branch/
  );
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ pull_requests: [{ ...greenRun().pull_requests[0], base: { ref: 'main', sha: A } }] }), REPOSITORY, pilotPr(), definition),
    /base SHA/
  );
});

test('GitHub-native CRITICAL request binds exact head, CI and classifier without legacy handoff', () => {
  const request = buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pilotPr(),
    changedPaths: ['src/v2/audit-contract.mjs'],
    sourceWorkflowRun: greenRun(),
    sourceWorkflowDefinition: workflowDefinition(),
    classifierSource: 'export const classifier = true;\n'
  });

  assert.equal(request.candidate.materialHeadSha, A);
  assert.equal(request.candidate.mergePreviewSha, M);
  assert.equal(request.candidate.risk.profile, 'critical');
  assert.equal(request.applicability.required, true);
  assert.equal(request.applicability.mode, 'independent');
  assert.equal(request.candidate.checks[0].workflowRunId, 9001);
  assert.equal(request.candidate.checks[0].name, 'Delivery V2 CI');
  assert.equal(request.candidate.legacyV1HandoffObserved, false);
  assert.equal(request.candidate.classifier.fingerprint, fingerprintClassifierSource('export const classifier = true;\n'));
  assert.equal(request.reviewerContextPolicy.includeImplementerHiddenReasoning, false);
  assert.equal(request.reviewerContextPolicy.legacyV1HandoffRequired, false);
});

test('controller injects reviewer identity, exact SHA and request fingerprint', () => {
  const request = buildRequest();
  const finalized = finalizeIndependentAuditResult({
    request,
    reviewerRunId: 9002,
    modelResult: { decision: 'approved', findings: [] }
  });
  assert.equal(finalized.result.candidateSha, A);
  assert.equal(finalized.result.requestFingerprint, request.requestFingerprint);
  assert.equal(finalized.result.reviewer.workerIdentity, DELIVERY_V2_CODEX_AUDITOR_IDENTITY);
  assert.equal(finalized.result.reviewer.runId, 9002);
  assert.equal(finalized.result.reviewer.contextIsolation, 'candidate-contract-evidence-only');
  assert.equal(finalized.outcome.status, 'approved');
  assert.equal(finalized.outcome.releaseBlocked, false);
});

test('reviewer run cannot reuse the implementer/PR run identity', () => {
  const request = buildRequest();
  assert.throws(() => finalizeIndependentAuditResult({
    request,
    reviewerRunId: 48,
    modelResult: { decision: 'approved', findings: [] }
  }), /independent/);
});

test('workflow and runtime enforce isolated inputs and controller-only durable write output', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../scripts/run-delivery-v2-independent-audit.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /Delivery V2 CI/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, delivery-orchestrator\]/);
  assert.match(workflow, /DELIVERY_GITHUB_READ_TOKEN/);
  assert.equal((workflow.match(/DELIVERY_GITHUB_WRITE_TOKEN/g) || []).length, 1);
  assert.match(workflow, /- name: Publish audit result to PR[\s\S]*?github-token: \$\{\{ secrets\.DELIVERY_GITHUB_WRITE_TOKEN \}\}/);
  assert.doesNotMatch(runner, /DELIVERY_GITHUB_WRITE_TOKEN/);
  assert.match(workflow, /DV2-AUDIT-PILOT: critical/);
  assert.match(workflow, /head\.repo\?\.full_name/);
  assert.match(workflow, /sameRepository && marked/);
  assert.doesNotMatch(workflow, /handoff-ready\.json/);
  assert.doesNotMatch(workflow, /\.audit\/entregar-issue/);
  const publishIndex = workflow.indexOf('- name: Publish audit result to PR');
  const uploadIndex = workflow.indexOf('- name: Upload machine-readable audit result');
  assert.ok(publishIndex >= 0 && uploadIndex > publishIndex, 'PR evidence must publish before artifact upload');
  assert.match(workflow, /- name: Upload machine-readable audit result\n\s+continue-on-error: true\n\s+uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /Source CI run:/);
  assert.match(workflow, /Audit workflow run:/);
  assert.match(runner, /assertTrustedCriticalAuditPilot/);
  assert.match(runner, /actions\/workflows\/\$\{sourceWorkflowRun\.workflow_id\}/);
  assert.match(runner, /sandboxMode: 'read-only'/);
  assert.match(runner, /networkAccessEnabled: false/);
  assert.match(runner, /finalizeIndependentAuditResult/);
  assert.doesNotMatch(runner, /handoff-ready\.json/);
});
