import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  computeTargetAuditReleaseGate,
  deriveTargetAuditProgress,
  normalizePersistedTargetAuditState
} from '../src/v2/target-audit-lineage.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PREVIEW = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const PRIOR = '1'.repeat(40);
const RUNTIME = '2'.repeat(40);
const FP = '3'.repeat(64);

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-target-lineage',
    repository: 'example-org/example-repo',
    issueNumber: 10,
    pullRequestNumber: 20,
    baseRef: 'develop',
    baseSha: BASE,
    headRef: 'feature/example',
    materialHeadSha: HEAD,
    mergePreviewSha: PREVIEW,
    mergeCommitSha: MERGE,
    classifierPath: '.delivery-v2/risk-profile.mjs',
    sourceWorkflow: {
      runId: 100,
      workflowId: 200,
      name: 'Validate PR',
      path: '.github/workflows/validate-pr.yml',
      event: 'pull_request',
      bindingJobName: 'CRITICAL validation',
      requiredJobs: [{
        name: 'CRITICAL validation',
        scope: 'material-head',
        expectedConclusion: 'success',
        requiredSteps: ['Full tests']
      }]
    },
    purpose: 'Synthetic lineage contract test',
    ...overrides
  };
}

function state(overrides = {}) {
  const findings = overrides.findings ?? [{ id: 'DV2-OLD-BLOCKER', blocksRelease: true }];
  const semanticDecision = overrides.semanticDecision ?? 'rejected';
  const releaseBlocked = overrides.releaseBlocked ?? true;
  const blockingFindingCount = overrides.blockingFindingCount ?? findings.filter((finding) => finding.blocksRelease === true).length;
  const releaseGatePassed = overrides.releaseGatePassed ?? (semanticDecision === 'approved' && releaseBlocked === false && blockingFindingCount === 0);
  const decision = overrides.decision ?? (releaseGatePassed ? 'approved' : 'rejected');
  return {
    schemaVersion: 3,
    controlRepository: 'example-org/controller',
    targetAuditId: 'synthetic-target-lineage',
    targetRepository: 'example-org/example-repo',
    issueNumber: 10,
    pullRequestNumber: 20,
    baseRef: 'develop',
    headRef: 'feature/example',
    candidateSha: PRIOR,
    mergePreviewSha: '4'.repeat(40),
    mergeCommitSha: '5'.repeat(40),
    auditWorkflowRunId: 300,
    sourceWorkflowRunId: 400,
    auditAttempt: 1,
    implementationAttempt: 1,
    semanticDecision,
    decision,
    releaseBlocked,
    blockingFindingCount,
    releaseGatePassed,
    requestFingerprint: FP,
    runtimeSha: RUNTIME,
    publisher: {
      workflowName: 'Delivery V2 Independent Audit',
      workflowPath: '.github/workflows/delivery-v2-independent-audit.yml',
      event: 'workflow_run'
    },
    findings,
    ...overrides
  };
}

test('durable target state cannot encode approval when deterministic release gate blocks', () => {
  const normalized = normalizePersistedTargetAuditState(state(), 99);
  assert.equal(normalized.decision, 'rejected');
  assert.equal(normalized.releaseGatePassed, false);

  assert.throws(
    () => normalizePersistedTargetAuditState(state({ decision: 'approved' }), 100),
    /durable decision disagrees/
  );
  assert.throws(
    () => normalizePersistedTargetAuditState(state({ blockingFindingCount: 0 }), 101),
    /blockingFindingCount disagrees/
  );
  assert.throws(
    () => normalizePersistedTargetAuditState(state({ releaseGatePassed: true }), 102),
    /releaseGatePassed disagrees/
  );
});

test('deterministic target release gate is fail closed across semantic, outcome and findings inputs', () => {
  assert.deepEqual(
    computeTargetAuditReleaseGate({ result: { decision: 'approved', findings: [] }, outcome: { releaseBlocked: false } }),
    { passed: true, durableDecision: 'approved', semanticDecision: 'approved', releaseBlocked: false, blockingFindingCount: 0 }
  );
  assert.deepEqual(
    computeTargetAuditReleaseGate({ result: { decision: 'approved', findings: [{ id: 'DV2-X', blocksRelease: true }] }, outcome: { releaseBlocked: false } }),
    { passed: false, durableDecision: 'rejected', semanticDecision: 'approved', releaseBlocked: false, blockingFindingCount: 1 }
  );
  assert.equal(
    computeTargetAuditReleaseGate({ result: { decision: 'rejected', findings: [] }, outcome: { releaseBlocked: true } }).passed,
    false
  );
});

test('remediation lineage carries attempts and findings across candidate-scoped SHA evidence changes', () => {
  const prior = normalizePersistedTargetAuditState(state({
    pullRequestNumber: 19,
    baseRef: 'main',
    headRef: 'feature/previous'
  }), 99);
  const progress = deriveTargetAuditProgress(config(), [prior]);
  assert.equal(progress.lineageId, 'synthetic-target-lineage');
  assert.equal(progress.auditAttempt, 2);
  assert.equal(progress.implementationAttempt, 2);
  assert.deepEqual(progress.priorFindings, [{ id: 'DV2-OLD-BLOCKER', candidateSha: PRIOR, status: 'previous-rejection' }]);

  const sameCandidate = normalizePersistedTargetAuditState(state({ candidateSha: HEAD }), 100);
  assert.throws(() => deriveTargetAuditProgress(config(), [sameCandidate]), /already has authoritative durable audit state/);
});

test('changing target audit id cannot reset budgets for the same stable target subject', () => {
  const prior = normalizePersistedTargetAuditState(state(), 99);
  assert.throws(
    () => deriveTargetAuditProgress(config({ id: 'synthetic-target-lineage-reset' }), [prior]),
    /lineage identifier changed/
  );
});

test('workflow evaluates deterministic gate before durable publication and enforces the same gate afterward', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  const target = workflow.slice(workflow.indexOf('  target_audit:'));
  const evaluate = target.indexOf('- name: Evaluate target audit release gate');
  const persist = target.indexOf('- name: Persist append-only target audit decision');
  const enforce = target.indexOf('- name: Enforce target audit decision');
  assert.ok(evaluate >= 0 && persist > evaluate && enforce > persist);
  assert.match(target, /scripts\/persist-delivery-v2-target-audit\.mjs/);
  assert.match(target, /computeTargetAuditReleaseGate/);
  const publisher = await readFile(new URL('../scripts/persist-delivery-v2-target-audit.mjs', import.meta.url), 'utf8');
  assert.match(publisher, /schemaVersion: 3/);
  assert.match(publisher, /semanticDecision:/);
  assert.match(publisher, /releaseGatePassed:/);
  assert.match(publisher, /blockingFindingCount:/);
  assert.match(publisher, /computeTargetAuditReleaseGate/);
  assert.match(publisher, /targetRepository: payload\.target\.repository/);
  assert.match(publisher, /baseRef: payload\.target\.baseRef/);
  assert.match(publisher, /headRef: payload\.target\.headRef/);
});

test('runner consumes only controller-attested lineage state and fingerprints the lineage runtime', async () => {
  const runner = await readFile(new URL('../scripts/run-delivery-v2-target-independent-audit.mjs', import.meta.url), 'utf8');
  const lineage = await readFile(new URL('../src/v2/target-audit-lineage.mjs', import.meta.url), 'utf8');
  assert.match(runner, /fetchControllerOwnedTargetAuditStates/);
  assert.match(runner, /deriveTargetAuditProgress/);
  assert.match(runner, /buildLineageTargetCriticalAuditRequest/);
  assert.match(runner, /lineageRuntimeFingerprint/);
  assert.match(runner, /schemaVersion: 3/);
  assert.match(lineage, /CONTROL_ENFORCEMENT_STEP_NAME/);
  assert.match(lineage, /run\?\.conclusion/);
  assert.match(lineage, /lineageId: config\.id/);
  assert.match(lineage, /executionIdentity:/);
  assert.match(lineage, /lineageRuntimeFingerprint/);
});
