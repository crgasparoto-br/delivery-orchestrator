import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditApplicability, buildAuditRequest, evaluateAuditOutcome, normalizeAuditInput, normalizeAuditResult } from '../src/v2/audit-contract.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(64);

function workflowEvidence(overrides = {}) {
  return {
    workflowId: 123,
    path: '.github/workflows/canonical-ci.yml',
    state: 'active',
    trustedBaseSha: B,
    blobSha: D,
    fingerprint: E,
    ...overrides
  };
}

function input(profile = 'critical') {
  return {
    schemaVersion: 1,
    repository: 'example-org/training-system',
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
      { name: 'Validate repository', required: true, scope: 'material-head', subjectSha: A, status: 'completed', conclusion: 'success', workflowRunId: 10, workflowEvidence: workflowEvidence() },
      { name: 'Merge preview integration', required: true, scope: 'merge-preview', subjectSha: C, status: 'completed', conclusion: 'success', workflowRunId: 10, workflowEvidence: workflowEvidence() }
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

test('issue 149: canonical audit-input schema supports legacy-unknown producer provenance', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../schemas/delivery-v2-audit-input.schema.json', import.meta.url),
    'utf8'
  ));

  assert.equal(
    schema.properties.implementationAttempt.anyOf.some((entry) => entry.type === 'null'),
    true
  );

  const implementer = schema.properties.implementer;

  assert.equal(
    implementer.properties.provenance.enum.includes('legacy-unknown'),
    true
  );

  const producerConditional = implementer.allOf[0];

  assert.equal(
    producerConditional.then.properties.provider.type,
    'null'
  );

  assert.equal(
    producerConditional.else.properties.provider.type,
    'string'
  );

  const attemptConditional = schema.allOf[0];

  assert.equal(
    attemptConditional.then.properties.implementationAttempt.type,
    'null'
  );

  assert.equal(
    attemptConditional.else.properties.implementationAttempt.type,
    'integer'
  );
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

test('every check requires durable workflow identity evidence', () => {
  const candidate = input();
  delete candidate.checks[0].workflowEvidence;
  assert.throws(() => normalizeAuditInput(candidate), /workflowEvidence must be an object/);

  const explicitNull = input();
  explicitNull.checks[0].workflowEvidence = null;
  assert.throws(() => normalizeAuditInput(explicitNull), /workflowEvidence must be an object/);
});

test('workflow check evidence is active, base-bound and fingerprint-validated', () => {
  const normalized = normalizeAuditInput(input());
  assert.equal(normalized.checks[0].workflowEvidence.workflowId, 123);
  assert.equal(normalized.checks[0].workflowEvidence.trustedBaseSha, B);

  const malformed = input();
  malformed.checks[0].workflowEvidence = workflowEvidence({ fingerprint: 'not-a-sha256' });
  assert.throws(() => normalizeAuditInput(malformed), /64-character SHA-256/);

  const missingState = input();
  missingState.checks[0].workflowEvidence = workflowEvidence({ state: undefined });
  assert.throws(() => normalizeAuditInput(missingState), /workflowEvidence.state is required/);

  const wrongBase = input();
  wrongBase.checks[0].workflowEvidence = workflowEvidence({ trustedBaseSha: A });
  assert.throws(() => normalizeAuditInput(wrongBase), /does not match audit baseSha/);
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
