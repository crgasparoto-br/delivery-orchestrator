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

function pilotPr(overrides = {}) {
  return {
    number: 46,
    title: 'security(v2): bind audit evidence to trusted CI workflow',
    body: 'Exercises the GitHub-native auditor.\n\nDV2-AUDIT-PILOT: critical\n',
    user: { login: 'implementer-user' },
    base: { ref: 'main', sha: B },
    head: { ref: 'test/dv2-audit-pilot', sha: A, repo: { full_name: REPOSITORY } },
    merge_commit_sha: M,
    ...overrides
  };
}

function greenRun(overrides = {}) {
  return {
    id: 9001,
    name: 'Delivery V2 CI',
    event: 'pull_request',
    repository: { full_name: REPOSITORY },
    head_sha: A,
    status: 'completed',
    conclusion: 'success',
    ...overrides
  };
}

test('CRITICAL pilot marker is explicit and line-bound', () => {
  assert.equal(isCriticalAuditPilot(pilotPr()), true);
  assert.equal(isCriticalAuditPilot(pilotPr({ body: 'mentions DV2-AUDIT-PILOT: critical inline only' })), false);
  assert.equal(isCriticalAuditPilot(pilotPr({ body: 'DV2-AUDIT-PILOT: standard' })), false);
});

test('runtime independently enforces trusted repository origin for CRITICAL pilots', () => {
  assert.equal(assertTrustedCriticalAuditPilot(pilotPr(), REPOSITORY).number, 46);
  assert.throws(
    () => assertTrustedCriticalAuditPilot(pilotPr({ head: { ref: 'fork', sha: A, repo: { full_name: 'attacker/fork' } } }), REPOSITORY),
    /trusted repository/
  );
  assert.throws(
    () => assertTrustedCriticalAuditPilot(pilotPr({ body: 'no pilot marker' }), REPOSITORY),
    /not marked/
  );
});

test('source audit evidence must come from the trusted exact-head Delivery V2 CI pull-request run', () => {
  assert.equal(assertTrustedSourceWorkflowRun(greenRun(), REPOSITORY, A).id, 9001);
  assert.throws(() => assertTrustedSourceWorkflowRun(greenRun({ name: 'Unrelated CI' }), REPOSITORY, A), /source workflow must be Delivery V2 CI/);
  assert.throws(() => assertTrustedSourceWorkflowRun(greenRun({ event: 'push' }), REPOSITORY, A), /source workflow event must be pull_request/);
  assert.throws(
    () => assertTrustedSourceWorkflowRun(greenRun({ repository: { full_name: 'attacker/fork' } }), REPOSITORY, A),
    /source workflow repository must be/
  );
});

test('GitHub-native CRITICAL request binds exact head, CI and classifier without legacy handoff', () => {
  const request = buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pilotPr(),
    changedPaths: ['src/v2/audit-contract.mjs'],
    sourceWorkflowRun: greenRun(),
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

test('stale or non-green CI cannot seed the independent audit', () => {
  const base = {
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pilotPr(),
    changedPaths: ['src/v2/audit-contract.mjs'],
    classifierSource: 'classifier'
  };
  assert.throws(() => buildGithubNativeCriticalAuditRequest({ ...base, sourceWorkflowRun: greenRun({ head_sha: B }) }), /stale/);
  assert.throws(() => buildGithubNativeCriticalAuditRequest({ ...base, sourceWorkflowRun: greenRun({ conclusion: 'failure' }) }), /terminal green/);
});

test('controller injects reviewer identity, exact SHA and request fingerprint', () => {
  const request = buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pilotPr(),
    changedPaths: ['src/v2/audit-contract.mjs'],
    sourceWorkflowRun: greenRun(),
    classifierSource: 'classifier'
  });
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
  const request = buildGithubNativeCriticalAuditRequest({
    repository: REPOSITORY,
    issueNumber: 27,
    pullRequest: pilotPr(),
    changedPaths: ['src/v2/audit-contract.mjs'],
    sourceWorkflowRun: greenRun(),
    classifierSource: 'classifier'
  });
  assert.throws(() => finalizeIndependentAuditResult({
    request,
    reviewerRunId: 46,
    modelResult: { decision: 'approved', findings: [] }
  }), /independent/);
});

test('workflow and runtime both enforce isolated trusted audit inputs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../scripts/run-delivery-v2-independent-audit.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /Delivery V2 CI/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, delivery-orchestrator\]/);
  assert.match(workflow, /DELIVERY_GITHUB_READ_TOKEN/);
  assert.doesNotMatch(workflow, /DELIVERY_GITHUB_WRITE_TOKEN/);
  assert.match(workflow, /DV2-AUDIT-PILOT: critical/);
  assert.match(workflow, /head\.repo\?\.full_name/);
  assert.match(workflow, /sameRepository && marked/);
  assert.doesNotMatch(workflow, /handoff-ready\.json/);
  assert.doesNotMatch(workflow, /\.audit\/entregar-issue/);
  assert.match(runner, /assertTrustedCriticalAuditPilot/);
  assert.match(runner, /sandboxMode: 'read-only'/);
  assert.match(runner, /finalizeIndependentAuditResult/);
  assert.doesNotMatch(runner, /handoff-ready\.json/);
});
