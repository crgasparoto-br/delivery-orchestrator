import { createHash } from 'node:crypto';
import { buildAuditRequest, evaluateAuditOutcome } from './audit-contract.mjs';

export const DELIVERY_V2_CRITICAL_AUDIT_PILOT_MARKER = 'DV2-AUDIT-PILOT: critical';
export const DELIVERY_V2_CODEX_AUDITOR_IDENTITY = 'delivery-v2-auditor-codex-critical';

const SHA_RE = /^[0-9a-f]{40}$/i;

function requiredString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredSha(value, label) {
  const sha = requiredString(value, label).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return sha;
}

export function isCriticalAuditPilot(pullRequest) {
  return String(pullRequest?.body ?? '').split(/\r?\n/).some((line) => line.trim() === DELIVERY_V2_CRITICAL_AUDIT_PILOT_MARKER);
}

export function fingerprintClassifierSource(source) {
  return createHash('sha256').update(requiredString(source, 'classifier source')).digest('hex');
}

export function buildGithubNativeCriticalAuditRequest({
  repository,
  issueNumber,
  pullRequest,
  changedPaths,
  sourceWorkflowRun,
  classifierSource,
  implementationAttempt = 1
} = {}) {
  if (!pullRequest || typeof pullRequest !== 'object') throw new Error('pullRequest is required');
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');
  if (!sourceWorkflowRun || typeof sourceWorkflowRun !== 'object') throw new Error('sourceWorkflowRun is required');

  const materialHeadSha = requiredSha(pullRequest.head?.sha, 'pullRequest.head.sha');
  const runHeadSha = requiredSha(sourceWorkflowRun.head_sha, 'sourceWorkflowRun.head_sha');
  if (runHeadSha !== materialHeadSha) throw new Error('source workflow is stale for the PR material head');
  if (sourceWorkflowRun.status !== 'completed' || sourceWorkflowRun.conclusion !== 'success') {
    throw new Error('source workflow must be terminal green before independent audit');
  }

  const mergePreviewSha = SHA_RE.test(String(pullRequest.merge_commit_sha ?? ''))
    ? String(pullRequest.merge_commit_sha).toLowerCase()
    : null;

  return buildAuditRequest({
    schemaVersion: 1,
    repository: requiredString(repository, 'repository'),
    issueNumber: requiredPositiveInteger(issueNumber, 'issueNumber'),
    pullRequestNumber: requiredPositiveInteger(pullRequest.number, 'pullRequest.number'),
    baseRef: requiredString(pullRequest.base?.ref, 'pullRequest.base.ref'),
    baseSha: requiredSha(pullRequest.base?.sha, 'pullRequest.base.sha'),
    headRef: requiredString(pullRequest.head?.ref, 'pullRequest.head.ref'),
    materialHeadSha,
    mergePreviewSha,
    risk: {
      profile: 'critical',
      reasons: ['dv2-critical-independent-audit-pilot']
    },
    classifier: {
      version: 'delivery-v2-risk-profile-v1',
      fingerprint: fingerprintClassifierSource(classifierSource)
    },
    checks: [{
      name: requiredString(sourceWorkflowRun.name, 'sourceWorkflowRun.name'),
      required: true,
      scope: 'material-head',
      subjectSha: materialHeadSha,
      status: sourceWorkflowRun.status,
      conclusion: sourceWorkflowRun.conclusion,
      workflowRunId: requiredPositiveInteger(sourceWorkflowRun.id, 'sourceWorkflowRun.id')
    }],
    changedPaths,
    implementationAttempt: requiredPositiveInteger(implementationAttempt, 'implementationAttempt'),
    implementer: {
      provider: 'github',
      workerIdentity: `github-pr-author:${requiredString(pullRequest.user?.login, 'pullRequest.user.login')}`,
      runId: requiredPositiveInteger(pullRequest.number, 'pullRequest.number')
    },
    priorFindings: []
  });
}

export function independentAuditModelOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'findings'],
    properties: {
      decision: { enum: ['approved', 'rejected'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'severity', 'violatedContract', 'surface', 'failureMode', 'evidence', 'remediationMode', 'blocksRelease'],
          properties: {
            id: { type: 'string', pattern: '^DV2-[A-Z0-9][A-Z0-9._-]*$' },
            severity: { enum: ['info', 'low', 'medium', 'high', 'critical'] },
            violatedContract: { type: 'string', minLength: 1 },
            surface: { type: 'string', minLength: 1 },
            failureMode: { type: 'string', minLength: 1 },
            evidence: { type: 'string', minLength: 1 },
            remediationMode: { enum: ['targeted', 'systemic'] },
            blocksRelease: { type: 'boolean' }
          }
        }
      }
    }
  };
}

export function finalizeIndependentAuditResult({ request, modelResult, reviewerRunId, provider = 'codex', workerIdentity = DELIVERY_V2_CODEX_AUDITOR_IDENTITY } = {}) {
  if (!request?.candidate?.materialHeadSha || !request?.requestFingerprint) throw new Error('exact audit request is required');
  if (!modelResult || typeof modelResult !== 'object' || Array.isArray(modelResult)) throw new Error('modelResult must be an object');
  if (!['approved', 'rejected'].includes(modelResult.decision)) throw new Error('modelResult.decision must be approved or rejected');
  if (!Array.isArray(modelResult.findings)) throw new Error('modelResult.findings must be an array');

  const result = {
    schemaVersion: 1,
    candidateSha: request.candidate.materialHeadSha,
    decision: modelResult.decision,
    requestFingerprint: request.requestFingerprint,
    reviewer: {
      provider: requiredString(provider, 'reviewer provider').toLowerCase(),
      workerIdentity: requiredString(workerIdentity, 'reviewer workerIdentity'),
      runId: requiredPositiveInteger(reviewerRunId, 'reviewerRunId'),
      contextIsolation: 'candidate-contract-evidence-only'
    },
    findings: modelResult.findings.map((finding) => ({
      ...finding,
      candidateSha: request.candidate.materialHeadSha
    }))
  };
  const outcome = evaluateAuditOutcome(request, result);
  return Object.freeze({ result: Object.freeze(result), outcome });
}
