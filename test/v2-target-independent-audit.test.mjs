import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertTargetSourceWorkflow,
  buildTargetCriticalAuditRequest,
  normalizeMergePreviewCommitEvidence,
  normalizeTargetAuditConfig,
  normalizeTargetAuditRuntimeEvidence,
  normalizeTargetDiffEvidence,
  normalizeTargetSourceBindingEvidence,
  normalizeTargetSourceGateEvidence
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

function requiredJobs() {
  return [
    { name: 'Delivery V2 risk', scope: 'material-head', expectedConclusion: 'success', requiredSteps: ['Classify PR deterministically'] },
    { name: 'Merge preview compatibility', scope: 'merge-preview', expectedConclusion: 'success', requiredSteps: ['STANDARD or CRITICAL type compatibility'] },
    { name: 'CRITICAL validation', scope: 'material-head', expectedConclusion: 'success', requiredSteps: ['Verify critical database and migration regressions', 'Full tests', 'Build'] },
    { name: 'FAST validation', scope: 'material-head', expectedConclusion: 'skipped', requiredSteps: [] },
    { name: 'STANDARD validation', scope: 'material-head', expectedConclusion: 'skipped', requiredSteps: [] },
    { name: 'Validate repository', scope: 'material-head', expectedConclusion: 'success', requiredSteps: ['Enforce adaptive validation result'] }
  ];
}

function config(overrides = {}) {
  const sourceWorkflow = {
    runId: 9001,
    workflowId: 7001,
    name: 'Validate PR',
    path: '.github/workflows/validate-pr.yml',
    event: 'pull_request',
    bindingJobName: 'Merge preview compatibility',
    requiredJobs: requiredJobs(),
    ...(overrides.sourceWorkflow ?? {})
  };
  const { sourceWorkflow: _discard, ...rest } = overrides;
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
    sourceWorkflow,
    purpose: 'Historical critical audit',
    ...rest
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 435,
    merged: true,
    merge_commit_sha: MERGE,
    user: { login: 'implementer' },
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
    head_sha: HEAD,
    head_branch: 'ci/431-delivery-v2-adaptive-gate',
    status: 'completed',
    conclusion: 'success',
    pull_requests: [],
    ...overrides
  };
}

function definition(overrides = {}) {
  return { id: 7001, name: 'Validate PR', path: '.github/workflows/validate-pr.yml', state: 'active', ...overrides };
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

function step(name, conclusion = 'success') {
  return { name, status: 'completed', conclusion };
}

function gateJobs() {
  let id = 8100;
  return requiredJobs().map((expected) => ({
    id: id++,
    name: expected.name,
    scope: expected.scope,
    expectedConclusion: expected.expectedConclusion,
    status: 'completed',
    conclusion: expected.expectedConclusion,
    requiredSteps: expected.requiredSteps,
    steps: expected.expectedConclusion === 'skipped' ? [] : expected.requiredSteps.map((name) => step(name))
  }));
}

function gateEvidence(jobs = gateJobs(), overrides = {}) {
  const body = { runId: 9001, jobs };
  return {
    ...body,
    fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
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
    allSnapshotsPresent: true,
    inventoryFingerprint: 'a'.repeat(64),
    snapshotFingerprint: 'b'.repeat(64),
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

const candidateWorkflow = { ref: HEAD, path: '.github/workflows/validate-pr.yml', blobSha: CANDIDATE_BLOB, content: 'name: Validate PR\non: pull_request\njobs:\n  critical: {}\n' };
const baseWorkflow = { ref: BASE, path: '.github/workflows/validate-pr.yml', blobSha: BASE_BLOB, content: 'name: Validate PR\non: pull_request\njobs:\n  full: {}\n' };

function buildRequest(overrides = {}) {
  return buildTargetCriticalAuditRequest({
    config: config(),
    pullRequest: pullRequest(),
    changedPaths: CHANGED_PATHS,
    sourceWorkflowRun: greenRun(),
    sourceWorkflowDefinition: definition(),
    sourceWorkflowBindingEvidence: binding(),
    sourceWorkflowGateEvidence: gateEvidence(),
    mergePreviewCommitEvidence: mergePreviewEvidence(),
    diffEvidence: diffEvidence(),
    candidateWorkflowEvidence: candidateWorkflow,
    baseWorkflowEvidence: baseWorkflow,
    classifierSource: 'export const classifier = true;\n',
    auditRuntimeEvidence: runtimeEvidence(),
    ...overrides
  });
}

test('target audit config binds immutable identity and a complete declared CRITICAL job matrix', () => {
  const normalized = normalizeTargetAuditConfig(config());
  assert.equal(normalized.mergePreviewSha, PREVIEW);
  assert.equal(normalized.mergeCommitSha, MERGE);
  assert.equal(normalized.sourceWorkflow.requiredJobs.length, 6);
  assert.equal(normalized.sourceWorkflow.requiredJobs.find((job) => job.name === 'CRITICAL validation').expectedConclusion, 'success');
  assert.throws(() => normalizeTargetAuditConfig(config({ mergePreviewSha: MERGE })), /distinct identities/);
  assert.throws(() => normalizeTargetAuditConfig(config({ sourceWorkflow: { requiredJobs: requiredJobs().filter((job) => job.name !== 'Merge preview compatibility') } })), /bindingJobName/);
});

test('historical source workflow requires positive PR/merge-preview corroboration and exact job reachability', () => {
  const resolved = assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition(), binding(), gateEvidence());
  assert.equal(resolved.gates.jobs.length, 6);
  assert.equal(resolved.gates.jobs.find((job) => job.name === 'FAST validation').conclusion, 'skipped');
  assert.throws(() => assertTargetSourceWorkflow(config(), pullRequest(), greenRun(), definition(), binding({ pullRequestNumber: 999 }), gateEvidence()), /configured pull request/);

  const missingCritical = gateJobs().filter((job) => job.name !== 'CRITICAL validation');
  assert.throws(() => normalizeTargetSourceGateEvidence(gateEvidence(missingCritical), config()), /inventory/);

  const skippedCritical = gateJobs().map((job) => job.name === 'CRITICAL validation' ? { ...job, conclusion: 'skipped', steps: [] } : job);
  assert.throws(() => normalizeTargetSourceGateEvidence(gateEvidence(skippedCritical), config()), /concluded skipped/);

  const missingRegressionStep = gateJobs().map((job) => job.name === 'CRITICAL validation' ? { ...job, steps: job.steps.filter((entry) => entry.name !== 'Full tests') } : job);
  assert.throws(() => normalizeTargetSourceGateEvidence(gateEvidence(missingRegressionStep), config()), /Full tests was not reached exactly once/);
});

test('GitHub-owned merge-preview evidence must be verified and have exact base/head parents', () => {
  const normalized = normalizeMergePreviewCommitEvidence(mergePreviewEvidence(), config());
  assert.equal(normalized.sha, PREVIEW);
  assert.deepEqual(normalized.parentShas, [BASE, HEAD]);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ parentShas: [HEAD, BASE] }), config()), /parents/);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ verified: false }), config()), /valid GitHub verification/);
  assert.throws(() => normalizeMergePreviewCommitEvidence(mergePreviewEvidence({ committerLogin: 'implementer-user' }), config()), /web-flow/);
});

test('diff evidence is fail-closed on exhaustive immutable base/head snapshots, not patch snippets', () => {
  const normalized = normalizeTargetDiffEvidence(diffEvidence(), CHANGED_PATHS);
  assert.equal(normalized.fileCount, 2);
  assert.equal(normalized.allSnapshotsPresent, true);
  assert.match(normalized.snapshotFingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => normalizeTargetDiffEvidence(diffEvidence({ allSnapshotsPresent: false }), CHANGED_PATHS), /complete base\/head snapshots/);
  assert.throws(() => normalizeTargetDiffEvidence(diffEvidence({ paths: [CHANGED_PATHS[0]], fileCount: 1 }), CHANGED_PATHS), /exactly match/);
});

test('runtime provenance schemas remain exact-SHA/fingerprint bound', () => {
  assert.equal(normalizeTargetSourceBindingEvidence(binding(), config()).mergePreviewSha, PREVIEW);
  assert.equal(normalizeTargetAuditRuntimeEvidence(runtimeEvidence()).runtimeSha, RUNTIME_SHA);
  assert.throws(() => normalizeTargetAuditRuntimeEvidence(runtimeEvidence({ runtimeSha: HEAD.slice(1) })), /40-character/);
});

test('target CRITICAL request binds every historical job, full snapshots, merge preview and final merge separately', () => {
  const request = buildRequest({ auditAttempt: 2, implementationAttempt: 2, priorFindings: [{ id: 'DV2-OLD-BLOCKER', candidateSha: '1'.repeat(40), status: 'previous-rejection' }] });
  assert.equal(request.candidate.materialHeadSha, HEAD);
  assert.equal(request.targetAudit.mergePreviewSha, PREVIEW);
  assert.equal(request.targetAudit.mergeCommitSha, MERGE);
  assert.equal(request.candidate.checks.length, 6);
  assert.equal(request.candidate.checks.find((check) => check.name === 'CRITICAL validation').conclusion, 'success');
  assert.equal(request.candidate.checks.find((check) => check.name === 'FAST validation').conclusion, 'skipped');
  assert.equal(request.candidate.checks.find((check) => check.name === 'Merge preview compatibility').scope, 'merge-preview');
  assert.equal(request.targetAudit.sourceWorkflow.gateEvidence.jobs.length, 6);
  assert.equal(request.targetAudit.diffEvidence.allSnapshotsPresent, true);
  assert.match(request.requestFingerprint, /^[0-9a-f]{64}$/);
});

test('configured training-system audit freezes canonical identity and all observed CRITICAL source gates', async () => {
  const raw = JSON.parse(await readFile(new URL('../config/delivery-v2-target-audits/training-system-435.json', import.meta.url), 'utf8'));
  const normalized = normalizeTargetAuditConfig(raw);
  assert.equal(normalized.repository, 'crgasparoto-br/training-system');
  assert.equal(normalized.materialHeadSha, 'ae0fade7be03c6c66f00fbd605bd85d9259aa622');
  assert.equal(normalized.mergePreviewSha, '7dbf31c8fc2b1d700da3ef54e78a947f4811243b');
  assert.equal(normalized.mergeCommitSha, '0fba4d2870e087775433b844e22f04c0daa84bcf');
  assert.equal(normalized.sourceWorkflow.runId, 34664164768);
  assert.equal(normalized.sourceWorkflow.requiredJobs.length, 6);
  assert.deepEqual(normalized.sourceWorkflow.requiredJobs.filter((job) => job.expectedConclusion === 'skipped').map((job) => job.name), ['FAST validation', 'STANDARD validation']);
  const critical = normalized.sourceWorkflow.requiredJobs.find((job) => job.name === 'CRITICAL validation');
  assert.ok(critical.requiredSteps.includes('Verify critical database and migration regressions'));
  assert.ok(critical.requiredSteps.includes('Validate settings parameters in real browser'));
  assert.ok(critical.requiredSteps.includes('Run actions/upload-artifact@v4'));
});

test('target workflow serializes audit through durable persistence and fails closed on semantic findings', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  const targetStart = workflow.indexOf('  target_audit:');
  assert.ok(targetStart > 0);
  const internal = workflow.slice(workflow.indexOf('  audit:'), targetStart);
  const target = workflow.slice(targetStart);
  assert.match(workflow, /github\.workflow_sha/);
  assert.match(internal, /Enforce independent audit decision/);
  assert.match(internal, /decision !== 'approved'/);
  assert.match(internal, /blocking\.length > 0/);
  assert.match(target, /delivery-v2-target-audit-\$\{\{ needs\.resolve\.outputs\.target_audit_id \}\}/);
  assert.match(target, /issues: write/);
  assert.match(target, /AUDIT_RUNTIME_SHA: \$\{\{ needs\.resolve\.outputs\.runtime_sha \}\}/);
  assert.match(target, /Persist append-only target audit decision/);
  assert.match(target, /delivery-v2-target-audit-state:/);
  assert.match(target, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(target, /decision !== 'approved'/);
  assert.match(target, /blocking\.length > 0/);
  assert.match(target, /releaseBlocked !== false/);
  assert.match(target, /Cleanup isolated target auditor runtime/);
  assert.match(target, /if: always\(\)/);
  assert.doesNotMatch(workflow, /\n  persist_target_audit:/);
  assert.doesNotMatch(workflow, /\n  enforce_target_audit:/);
  assert.ok(target.indexOf('Run configured target independent audit') < target.indexOf('Persist append-only target audit decision'));
  assert.ok(target.indexOf('Persist append-only target audit decision') < target.indexOf('Enforce target audit decision'));
  assert.equal((workflow.match(/DELIVERY_GITHUB_WRITE_TOKEN/g) || []).length, 1);
});

test('target runner uses full snapshots and controller-owned durable state without granting model write/network authority', async () => {
  const runner = await readFile(new URL('../scripts/run-delivery-v2-target-independent-audit.mjs', import.meta.url), 'utf8');
  assert.match(runner, /allSnapshotsPresent: true/);
  assert.match(runner, /snapshots\/base/);
  assert.match(runner, /snapshots\/head/);
  assert.match(runner, /SOURCE_WORKFLOW_GATES\.json/);
  assert.match(runner, /github-actions\[bot\]/);
  assert.match(runner, /CONTROL_WORKFLOW_PATH/);
  assert.match(runner, /actions\/runs\/\$\{state\.auditWorkflowRunId\}/);
  assert.match(runner, /networkAccessEnabled: false/);
  assert.match(runner, /sandboxMode: 'read-only'/);
  assert.match(runner, /githubToken: ''/);
  assert.doesNotMatch(runner, /allPatchesPresent/);
  assert.doesNotMatch(runner, /DELIVERY_GITHUB_WRITE_TOKEN/);
  assert.doesNotMatch(runner, /\.audit\/entregar-issue/);
});
