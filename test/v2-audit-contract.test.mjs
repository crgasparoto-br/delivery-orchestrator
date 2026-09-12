import assert from 'node:assert/strict';
import test from 'node:test';
import { auditApplicability, buildAuditRequest, evaluateAuditOutcome, normalizeAuditInput, normalizeAuditResult } from '../src/v2/audit-contract.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function input(profile = 'critical') {
  return {
    schemaVersion: 1,
    repository: 'crgasparoto-br/training-system',
    issueNumber: 431,
    pullRequestNumber: 435,
    baseRef: 'develop',
    baseSha: B,
    headRef: 'ci/431-delivery-v2-adaptive-gate',
    materialHeadSha: A,
    mergePreviewSha: C,
    risk: { profile, reasons: ['core-sensitive-boundary:apps/web/src/pages/login.tsx'] },
    classifier: { version: '1', fingerprint: 'classifier-fingerprint' },
    checks: [
      { name: 'Validate repository', required: true, scope: 'material-head', subjectSha: A, status: 'completed', conclusion: 'success', workflowRunId: 10 },
      { name: 'Merge preview integration', required: true, scope: 'merge-preview', subjectSha: C, status: 'completed', conclusion: 'success', workflowRunId: 10 }
    ],
    changedPaths: ['apps/web/src/pages/Login.tsx'],
    implementationAttempt: 1,
    implementer: { provider: 'codex', workerIdentity: 'delivery-v2-worker-codex-critical', runId: 100 },
    priorFindings: [],
    legacyV1Handoff: { stale: true, materialHeadSha: B }
  };
}

function approvedResult(request, overrides = {}) {
  return {
    schemaVersion: 1,
    candidateSha: A,
    decision: 'approved',
    requestFingerprint: request.requestFingerprint,
    reviewer: { provider: 'claude', workerIdentity: 'delivery-v2-auditor-claude-critical', runId: 200, contextIsolation: 'candidate-contract-evidence-only' },
    findings: [],
    ...overrides
  };
}

test('normalizes GitHub-native candidate evidence and treats stale V1 handoff as non-blocking metadata', () => {
  const normalized = normalizeAuditInput(input());
  assert.equal(normalized.materialHeadSha, A);
  assert.equal(normalized.legacyV1HandoffObserved, true);
  assert.equal(normalized.policy.auditMode, 'independent');
});

test('FAST has no mandatory audit while STANDARD can be policy-configured and CRITICAL is mandatory', () => {
  assert.equal(auditApplicability(input('fast')).required, false);
  assert.equal(auditApplicability(input('standard'), { standardAuditRequired: false }).required, false);
  assert.equal(auditApplicability(input('standard'), { standardAuditRequired: true }).mode, 'focused-independent');
  assert.equal(auditApplicability(input('critical')).mode, 'independent');
});

test('CRITICAL audit request excludes implementer hidden reasoning and legacy V1 dependency', () => {
  const request = buildAuditRequest(input());
  assert.equal(request.reviewerContextPolicy.includeImplementerHiddenReasoning, false);
  assert.equal(request.reviewerContextPolicy.legacyV1HandoffRequired, false);
  assert.match(request.requestFingerprint, /^[0-9a-f]{64}$/);
});

test('rejects stale required check evidence before audit can start', () => {
  const candidate = input();
  candidate.checks[0].subjectSha = B;
  assert.throws(() => normalizeAuditInput(candidate), /stale/);
});

test('rejects CRITICAL approval produced by the implementation worker or run', () => {
  const request = buildAuditRequest(input());
  const result = approvedResult(request, { reviewer: { provider: 'codex', workerIdentity: 'delivery-v2-worker-codex-critical', runId: 201, contextIsolation: 'candidate-contract-evidence-only' } });
  assert.throws(() => normalizeAuditResult(result, request), /independent/);
});

test('approval is exact-SHA and exact-request bound', () => {
  const request = buildAuditRequest(input());
  assert.equal(evaluateAuditOutcome(request, approvedResult(request)).releaseBlocked, false);
  assert.throws(() => normalizeAuditResult({ ...approvedResult(request), candidateSha: B }, request), /stale/);
  assert.throws(() => evaluateAuditOutcome(request, { ...approvedResult(request), requestFingerprint: '0'.repeat(64) }), /requestFingerprint/);
});

test('machine-usable blocking finding rejects release with stable remediation data', () => {
  const request = buildAuditRequest(input());
  const result = approvedResult(request, {
    decision: 'rejected',
    findings: [{
      id: 'DV2-AUTH-001', severity: 'high', candidateSha: A,
      violatedContract: 'Protected route must remain CRITICAL', surface: 'apps/web/src/components/RoleGuard.tsx',
      failureMode: 'safe-root routing downgrades an access-control boundary', evidence: 'classifier returned fast for RoleGuard',
      remediationMode: 'systemic', blocksRelease: true
    }]
  });
  const outcome = evaluateAuditOutcome(request, result);
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.releaseBlocked, true);
  assert.equal(outcome.findings[0].remediationMode, 'systemic');
});

test('approved audit cannot hide a blocking finding', () => {
  const request = buildAuditRequest(input());
  const result = approvedResult(request, { findings: [{
    id: 'DV2-BLOCK-001', severity: 'critical', candidateSha: A, violatedContract: 'contract', surface: 'surface', failureMode: 'failure', evidence: 'evidence', remediationMode: 'targeted', blocksRelease: true
  }] });
  assert.throws(() => normalizeAuditResult(result, request), /approved audit cannot contain/);
});
