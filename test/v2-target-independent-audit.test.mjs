import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertTargetPullRequest,
  assertTargetSourceWorkflow,
  buildTargetCriticalAuditRequest,
  normalizeMergePreviewCommitEvidence,
  normalizeTargetAuditConfig,
  normalizeTargetAuditRuntimeEvidence,
  normalizeTargetDiffEvidence,
  normalizeTargetSourceBindingEvidence
} from '../src/v2/target-independent-audit-runtime.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const CANDIDATE_BLOB = 'd'.repeat(40);
const BASE_BLOB = 'e'.repeat(40);
const PREVIEW = 'f'.repeat(40);
const RUNTIME_SHA = '9'.repeat(40);
const REPOSITORY = 'example-org/training-system';
const CHANGED_PATHS = ['.github/workflows/validate-pr.yml', '.delivery-v2/risk-profile.mjs'];

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
    mergePreviewSha: PREVIEW,
    mergeCommitSha: MERGE,
    classifierPath: '.delivery-v2/risk-profile.mjs',
    sourceWorkflow: {
      runId: 9001,
      workflowId: 7001,
      name: 'Validate PR',
      path: '.github/workflows/validate-pr.yml',
      event: 'pull_request',
      bindingJobName: 'Merge preview compatibility'
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

function binding(overrides = {}) {
  return {
    jobId: 8001,
    jobName: 'Merge preview compatibility',
    status: 'completed',
    conclusion: 'success',
    pullRequestNumber: 435,
    mergePreviewSha: PREVIEW,
    materialHeadSha: HEAD,
    logFingerprint: '1'.repeat(64),
    refMappingObserved: true,
    checkoutObserved: true,
    ...overrides
  };
}

function mergePreviewEvidence(overrides = {}) {
  return {
    sha: PREVIEW,
    parentShas: [BASE, HEAD],
    treeSha: '7'.repeat(40),
    message: `Merge ${HEAD} into ${BASE}`,
    verified: true,
    verificationReason: 'valid',
    committerLogin: 'web-flow',
    fingerprint: '8'.repeat(64),
    ...overrides
  };
}

function diffEvidence(overrides = {}) {
  return {
    fileCount: CHANGED_PATHS.length,
    paths: CHANGED_PATHS,
    allPatchesPresent: true,
    inventoryFingerprint: 'a'.repeat(64),
    diffFingerprint: 'b'.repeat(64),
    ...overrides
  };
}

function runtimeEvidence(overrides = {}) {
  return {
    runtimeSha: RUNTIME_SHA,
    contractFingerprint: '2'.repeat(64),
    targetConfigFingerprint: '3'.repeat(64),
    runnerFingerprint: '4'.repeat(64),
    targetRuntimeFingerprint: '5'.repeat(64),
    workflowFingerprint: '6'.repeat(64),
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

function buildRequest(overrides = {}) {
  return buildTargetCriticalAuditRequest({
    config: config(),
    pullRequest: pullRequest(),
    changedPaths: CHANGED_PATHS,
    sourceWorkflowRun: greenRun(),
    sourceWorkflowDefinition: definition(),
    sourceWorkflowBindingEvidence: binding(),
    mergePreviewCommitEvidence: mergePreviewEvidence(),
    diffEvidence: diffEvidence(),
    candidateWorkflowEvidence: candidateWorkflow,
    baseWorkflowEvidence: baseWorkflow,
    classifierSource: 'export const classifier = true;\n',
    auditRuntimeEvidence: runtimeEvidence(),
    ...overrides
  });
}

test('target audit config binds immutable historical PR, merge preview, merge commit and source-CI identity', () => {
  const normalized = normalizeTargetAuditConfig(config());
  assert.equal(normalized.id, 'training-system-435');
  assert.equal(normalized.repository, REPOSITORY);
  assert.equal(normalized.materialHeadSha, HEAD);
  assert.equal(normalized.mergePreviewSha, PREVIEW);
  assert.equal(normalized.mergeCommitSha, MERGE);
  assert.notEqual(normalized.mergePreviewSha, normalized.mergeCommitSha);
  assert.equal(normalized.sourceWorkflow.runId, 9001);
  assert.equal(normalized.sourceWorkflow.bindingJobName, 'Merge preview compatibility');
  assert.equal(assertTargetPullRequest(normalized, pullRequest()).pullRequest.number, 435);
  assert.throws(() => assertTargetPullRequest(normalized, pullRequest({ merge_commit_sha: HEAD })), /merge commit/);
  assert.throws(() => assertTargetPullRequest(normalized, pullRequest({ head: { ref: 'other', sha: HEAD, repo: { full_name: REPOSITORY } } })), /head ref/);
  assert.throws(() => normalizeTargetAuditConfig(config({ mergePreviewSha: MERGE })), /distinct identities/);
});

test('source job is corroboration only and still rejects mismatched target identity', () => {
  const resolved = assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition(), binding());
  assert.equal(resolved.run.id, 9001);
  assert.equal(resolved.binding.pullRequestNumber, 435);
  assert.equal(resolved.binding.mergePreviewSha, PREVIEW);
  assert.deepEqual(resolved.run.pull_requests, []);
  assert.throws(() => assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition()), /sourceWorkflowBindingEvidence/);
  assert.throws(() => assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition(), binding({ pullRequestNumber: 999 })), /configured pull request/);
  assert.throws(() => assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition(), binding({ mergePreviewSha: MERGE })), /configured merge preview/);
  assert.throws(() => assertTargetSourceWorkflow(config(), pullRequest(), greenRun({ pull_requests: [{ number: 999 }] }), definition(), binding()), /conflicting pull request association/);
  assert.throws(() => assertTargetSourceWorkflow(config(), pullRequest(), greenRun({ head_sha: BASE }), definition(), binding()), /stale for target candidate/);
});

test('GitHub-owned merge-preview evidence must be verified and have exact base/head parents', () => {
  const normalized = normalizeMergePreviewCommitEvidence(mergePreviewEvidence(), config());
  assert.equal(normalized.sha, PREVIEW);
  assert.deepEqual(normalized.parentShas, [BASE, HEAD]);
  assert.equal(normalized.committerLogin, 'web-flow');
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ parentShas: [HEAD, BASE] }), config()), /parents/);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ verified: false }), config()), /valid GitHub verification/);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ verificationReason: 'unsigned' }), config()), /valid GitHub verification/);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ committerLogin: 'implementer-user' }), config()), /web-flow/);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ message: 'synthetic output' }), config()), /message/);
});

test('diff evidence must cover every changed path exactly and require patches for all files', () => {
  const normalized = normalizeTargetDiffEvidence(diffEvidence(), CHANGED_PATHS);
  assert.equal(normalized.fileCount, CHANGED_PATHS.length);
  assert.deepEqual(normalized.paths, CHANGED_PATHS);
  assert.throws(() => normalizeTargetDiffEvidence(diffEvidence({ paths: [CHANGED_PATHS[0]] }), CHANGED_PATHS), /exactly match/);
  assert.throws(() => normalizeTargetDiffEvidence(diffEvidence({ paths: [...CHANGED_PATHS, 'extra.txt'], fileCount: 3 }), CHANGED_PATHS), /exactly match/);
  assert.throws(() => normalizeTargetDiffEvidence(diffEvidence({ allPatchesPresent: false }), CHANGED_PATHS), /patch for every changed file/);
  assert.throws(() => normalizeTargetDiffEvidence(diffEvidence({ fileCount: 1 }), CHANGED_PATHS), /fileCount/);
});

test('binding and runtime provenance schemas fail closed on malformed evidence', () => {
  assert.equal(normalizeTargetSourceBindingEvidence(binding(), config()).jobId, 8001);
  assert.equal(normalizeTargetAuditRuntimeEvidence(runtimeEvidence()).runtimeSha, RUNTIME_SHA);
  assert.throws(() => normalizeTargetSourceBindingEvidence(binding({ logFingerprint: 'abc' }), config()), /64-character/);
  assert.throws(() => normalizeTargetAuditRuntimeEvidence(runtimeEvidence({ contractFingerprint: 'abc' })), /64-character/);
  assert.throws(() => normalizeTargetAuditRuntimeEvidence(runtimeEvidence({ runtimeSha: HEAD.slice(1) })), /40-character/);
});

test('target CRITICAL request persists authoritative preview, exhaustive diff evidence and bounded audit state', () => {
  const request = buildRequest({
    auditAttempt: 2,
    implementationAttempt: 2,
    priorFindings: [{ id: 'DV2-OLD-BLOCKER', candidateSha: '1'.repeat(40), status: 'previous-rejection' }]
  });

  assert.equal(request.candidate.materialHeadSha, HEAD);
  assert.equal(request.candidate.baseSha, BASE);
  assert.equal(request.candidate.mergePreviewSha, PREVIEW);
  assert.equal(request.targetAudit.mergePreviewSha, PREVIEW);
  assert.equal(request.targetAudit.mergeCommitSha, MERGE);
  assert.equal(request.targetAudit.auditAttempt, 2);
  assert.equal(request.targetAudit.maxAuditRemediationCycles, 2);
  assert.equal(request.targetAudit.sameCandidateReauditAllowed, false);
  assert.equal(request.targetAudit.mergePreviewTrust, 'github-verified-commit-object-with-reviewed-source-job-corroboration');
  assert.deepEqual(request.targetAudit.mergePreviewEvidence.parentShas, [BASE, HEAD]);
  assert.deepEqual(request.targetAudit.diffEvidence.paths, CHANGED_PATHS);
  assert.equal(request.candidate.implementationAttempt, 2);
  assert.equal(request.candidate.priorFindings[0].id, 'DV2-OLD-BLOCKER');
  assert.equal(request.targetAudit.sourceCiTrust, 'candidate-workflow-under-independent-review');
  assert.equal(request.targetAudit.sourceWorkflow.corroborationEvidence.jobId, 8001);
  assert.equal(request.targetAudit.sourceWorkflow.historicalAssociationPolicy, 'github-merge-preview-commit-is-authoritative-source-job-log-is-corroboration-only');
  assert.equal(request.candidate.checks.length, 2);
  assert.equal(request.candidate.checks[0].scope, 'material-head');
  assert.equal(request.candidate.checks[1].scope, 'merge-preview');
  assert.equal(request.candidate.checks[1].subjectSha, PREVIEW);
  assert.match(request.requestFingerprint, /^[0-9a-f]{64}$/);
});

test('target audit attempt and implementation budgets fail closed', () => {
  assert.throws(() => buildRequest({ auditAttempt: 4, implementationAttempt: 3 }), /audit-remediation budget/);
  assert.throws(() => buildRequest({ auditAttempt: 3, implementationAttempt: 4 }), /implementation budget/);
});

test('configured training-system audit freezes the canonical DV2-013 historical identity', async () => {
  const raw = JSON.parse(await readFile(new URL('../config/delivery-v2-target-audits/training-system-435.json', import.meta.url), 'utf8'));
  const normalized = normalizeTargetAuditConfig(raw);
  assert.equal(normalized.repository, 'crgasparoto-br/training-system');
  assert.equal(normalized.pullRequestNumber, 435);
  assert.equal(normalized.materialHeadSha, 'ae0fade7be03c6c66f00fbd605bd85d9259aa622');
  assert.equal(normalized.baseSha, 'b2952652539998708e3ae5fc74cadd7fa68e98fe');
  assert.equal(normalized.mergePreviewSha, '7dbf31c8fc2b1d700da3ef54e78a947f4811243b');
  assert.equal(normalized.mergeCommitSha, '0fba4d2870e087775433b844e22f04c0daa84bcf');
  assert.equal(normalized.sourceWorkflow.runId, 34664164768);
  assert.equal(normalized.sourceWorkflow.workflowId, 277560379);
  assert.equal(normalized.sourceWorkflow.bindingJobName, 'Merge preview compatibility');
});

test('target audit workflow pins runtime, serializes target attempts, persists append-only state and enforces approval', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../scripts/run-delivery-v2-target-independent-audit.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /DV2-TARGET-AUDIT:/);
  assert.match(workflow, /github\.workflow_sha/);
  assert.match(workflow, /delivery-v2-target-audit-\$\{\{ needs\.resolve\.outputs\.target_audit_id \}\}/);
  assert.match(workflow, /AUDIT_RUNTIME_SHA: \$\{\{ needs\.resolve\.outputs\.runtime_sha \}\}/);
  assert.match(workflow, /Persist append-only target audit decision/);
  assert.match(workflow, /delivery-v2-target-audit-state:/);
  assert.match(workflow, /auditWorkflowRunId/);
  assert.match(workflow, /candidateMarkerPrefix/);
  assert.match(workflow, /append-only policy forbids overwrite or re-audit/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  persist_target_audit:'), workflow.indexOf('  enforce_target_audit:')), /updateComment/);
  assert.match(workflow, /Enforce target audit decision/);
  assert.match(workflow, /decision !== 'approved'/);
  assert.match(workflow, /releaseBlocked !== false/);
  assert.equal((workflow.match(/DELIVERY_GITHUB_WRITE_TOKEN/g) || []).length, 1);

  const targetStart = workflow.indexOf('  target_audit:');
  const persistStart = workflow.indexOf('  persist_target_audit:');
  const enforceStart = workflow.indexOf('  enforce_target_audit:');
  assert.ok(targetStart >= 0 && persistStart > targetStart && enforceStart > persistStart);
  const targetSection = workflow.slice(targetStart, persistStart);
  const persistSection = workflow.slice(persistStart, enforceStart);
  assert.doesNotMatch(targetSection, /issues:\s+write/);
  assert.doesNotMatch(targetSection, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(persistSection, /issues:\s+write/);
  assert.match(persistSection, /github-token: \$\{\{ github\.token \}\}/);

  assert.doesNotMatch(runner, /DELIVERY_GITHUB_WRITE_TOKEN/);
  assert.match(runner, /sandboxMode: 'read-only'/);
  assert.match(runner, /networkAccessEnabled: false/);
  assert.match(runner, /MERGE_PREVIEW_COMMIT\.json/);
  assert.match(runner, /SOURCE_WORKFLOW_CORROBORATION\.log/);
  assert.match(runner, /CHANGED_FILES\.json/);
  assert.match(runner, /DIFF_COVERAGE\.json/);
  assert.match(runner, /PRIOR_TARGET_AUDITS\.json/);
  assert.match(runner, /commits\/\$\{config\.mergePreviewSha\}/);
  assert.match(runner, /candidate diff paths do not exactly match changed-file inventory/);
  assert.match(runner, /changed-file evidence is incomplete: patch missing/);
  assert.match(runner, /already has durable audit state; a new material SHA is required before re-audit/);
  assert.match(runner, /delivery-v2-target-audit-state:/);
  assert.match(runner, /git', \['rev-parse', 'HEAD'\]/);
  assert.match(runner, /AUDIT_RUNTIME_SHA/);
  assert.doesNotMatch(runner, /handoff-ready\.json/);
});
