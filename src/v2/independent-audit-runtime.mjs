import { createHash } from 'node:crypto';
import { buildAuditRequest, evaluateAuditOutcome } from './audit-contract.mjs';

export const DELIVERY_V2_CRITICAL_AUDIT_PILOT_MARKER = 'DV2-AUDIT-PILOT: critical';
export const DELIVERY_V2_CODEX_AUDITOR_IDENTITY = 'delivery-v2-auditor-codex-critical';
export const DELIVERY_V2_SOURCE_WORKFLOW_NAME = 'Delivery V2 CI';
export const DELIVERY_V2_SOURCE_WORKFLOW_EVENT = 'pull_request';
export const DELIVERY_V2_SOURCE_WORKFLOW_PATH = '.github/workflows/delivery-v2-ci.yml';

const SHA_RE = /^[0-9a-f]{40}$/i;

function requiredObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

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

function assertSameString(actual, expected, label) {
  if (requiredString(actual, label) !== requiredString(expected, `expected ${label}`)) {
    throw new Error(`${label} does not match the audited pull request`);
  }
}

function assertSameSha(actual, expected, label) {
  if (requiredSha(actual, label) !== requiredSha(expected, `expected ${label}`)) {
    throw new Error(`${label} does not match the audited pull request`);
  }
}

function assertSameRepositoryId(actual, expected, label) {
  if (requiredPositiveInteger(actual, label) !== requiredPositiveInteger(expected, `expected ${label}`)) {
    throw new Error(`${label} does not match the audited pull request repository`);
  }
}

function workflowFileEvidence(value, label) {
  const evidence = requiredObject(value, label);
  const path = requiredString(evidence.path, `${label}.path`);
  if (path !== DELIVERY_V2_SOURCE_WORKFLOW_PATH) throw new Error(`${label}.path must be ${DELIVERY_V2_SOURCE_WORKFLOW_PATH}`);
  return Object.freeze({
    ref: requiredSha(evidence.ref, `${label}.ref`),
    path,
    blobSha: requiredSha(evidence.blobSha, `${label}.blobSha`),
    content: requiredString(evidence.content, `${label}.content`)
  });
}

export function fingerprintWorkflowSource(source) {
  return createHash('sha256').update(requiredString(source, 'workflow source')).digest('hex');
}

export function isCriticalAuditPilot(pullRequest) {
  return String(pullRequest?.body ?? '').split(/\r?\n/).some((line) => line.trim() === DELIVERY_V2_CRITICAL_AUDIT_PILOT_MARKER);
}

export function assertTrustedCriticalAuditPilot(pullRequest, repository) {
  if (!pullRequest || typeof pullRequest !== 'object') throw new Error('pullRequest is required');
  const expectedRepository = requiredString(repository, 'repository');
  const headRepository = requiredString(pullRequest.head?.repo?.full_name, 'pullRequest.head.repo.full_name');
  const baseRepository = requiredString(pullRequest.base?.repo?.full_name, 'pullRequest.base.repo.full_name');
  if (headRepository !== expectedRepository || baseRepository !== expectedRepository) {
    throw new Error(`CRITICAL audit pilot must originate from and target the trusted repository: expected ${expectedRepository}`);
  }
  if (!isCriticalAuditPilot(pullRequest)) throw new Error('PR is not marked as a DV2 CRITICAL audit pilot');
  return pullRequest;
}

export function assertTrustedSourceWorkflowRun(sourceWorkflowRun, repository, pullRequest, sourceWorkflowDefinition, sourceWorkflowEvidence) {
  const run = requiredObject(sourceWorkflowRun, 'sourceWorkflowRun');
  const pr = requiredObject(pullRequest, 'pullRequest');
  const definition = requiredObject(sourceWorkflowDefinition, 'sourceWorkflowDefinition');
  const evidence = requiredObject(sourceWorkflowEvidence, 'sourceWorkflowEvidence');
  const expectedRepository = requiredString(repository, 'repository');
  const materialHeadSha = requiredSha(pr.head?.sha, 'pullRequest.head.sha');
  const baseSha = requiredSha(pr.base?.sha, 'pullRequest.base.sha');

  if (requiredString(run.name, 'sourceWorkflowRun.name') !== DELIVERY_V2_SOURCE_WORKFLOW_NAME) {
    throw new Error(`source workflow must be ${DELIVERY_V2_SOURCE_WORKFLOW_NAME}`);
  }
  if (requiredString(run.event, 'sourceWorkflowRun.event').toLowerCase() !== DELIVERY_V2_SOURCE_WORKFLOW_EVENT) {
    throw new Error(`source workflow event must be ${DELIVERY_V2_SOURCE_WORKFLOW_EVENT}`);
  }
  if (requiredString(run.repository?.full_name, 'sourceWorkflowRun.repository.full_name') !== expectedRepository) {
    throw new Error(`source workflow repository must be ${expectedRepository}`);
  }
  if (requiredSha(run.head_sha, 'sourceWorkflowRun.head_sha') !== materialHeadSha) {
    throw new Error('source workflow is stale for the PR material head');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('source workflow must be terminal green before independent audit');
  }

  const runWorkflowId = requiredPositiveInteger(run.workflow_id, 'sourceWorkflowRun.workflow_id');
  const definitionWorkflowId = requiredPositiveInteger(definition.id, 'sourceWorkflowDefinition.id');
  if (runWorkflowId !== definitionWorkflowId) throw new Error('source workflow_id does not match the resolved workflow definition');
  if (requiredString(definition.name, 'sourceWorkflowDefinition.name') !== DELIVERY_V2_SOURCE_WORKFLOW_NAME) {
    throw new Error(`resolved workflow definition must be ${DELIVERY_V2_SOURCE_WORKFLOW_NAME}`);
  }
  if (requiredString(definition.path, 'sourceWorkflowDefinition.path') !== DELIVERY_V2_SOURCE_WORKFLOW_PATH) {
    throw new Error(`resolved workflow definition must use ${DELIVERY_V2_SOURCE_WORKFLOW_PATH}`);
  }
  if (requiredString(run.path, 'sourceWorkflowRun.path') !== DELIVERY_V2_SOURCE_WORKFLOW_PATH) {
    throw new Error(`source workflow run must use ${DELIVERY_V2_SOURCE_WORKFLOW_PATH}`);
  }
  if (requiredString(definition.state, 'sourceWorkflowDefinition.state').toLowerCase() !== 'active') {
    throw new Error('source workflow definition must be active');
  }

  assertSameString(run.head_branch, pr.head?.ref, 'sourceWorkflowRun.head_branch');
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) {
    throw new Error('source workflow must be bound to exactly one pull request');
  }
  const binding = requiredObject(run.pull_requests[0], 'sourceWorkflowRun.pull_requests[0]');
  if (requiredPositiveInteger(binding.number, 'sourceWorkflowRun.pull_requests[0].number') !== requiredPositiveInteger(pr.number, 'pullRequest.number')) {
    throw new Error('source workflow pull request number does not match the audited pull request');
  }
  assertSameString(binding.head?.ref, pr.head?.ref, 'source workflow PR head ref');
  assertSameSha(binding.head?.sha, pr.head?.sha, 'source workflow PR head SHA');
  assertSameRepositoryId(binding.head?.repo?.id, pr.head?.repo?.id, 'source workflow PR head repository id');
  assertSameString(binding.base?.ref, pr.base?.ref, 'source workflow PR base ref');
  assertSameSha(binding.base?.sha, pr.base?.sha, 'source workflow PR base SHA');
  assertSameRepositoryId(binding.base?.repo?.id, pr.base?.repo?.id, 'source workflow PR base repository id');

  const candidateWorkflow = workflowFileEvidence(evidence.candidate, 'sourceWorkflowEvidence.candidate');
  const trustedBaseWorkflow = workflowFileEvidence(evidence.trustedBase, 'sourceWorkflowEvidence.trustedBase');
  if (candidateWorkflow.ref !== materialHeadSha) throw new Error('candidate workflow ref does not match the audited material head');
  if (trustedBaseWorkflow.ref !== baseSha) throw new Error('trusted workflow ref does not match the audited base SHA');
  if (candidateWorkflow.blobSha !== trustedBaseWorkflow.blobSha) {
    throw new Error('source workflow content does not match the trusted base workflow blob');
  }
  const candidateFingerprint = fingerprintWorkflowSource(candidateWorkflow.content);
  const trustedBaseFingerprint = fingerprintWorkflowSource(trustedBaseWorkflow.content);
  if (candidateFingerprint !== trustedBaseFingerprint) {
    throw new Error('source workflow content fingerprint does not match the trusted base workflow');
  }

  return Object.freeze({
    run,
    workflowEvidence: Object.freeze({
      workflowId: runWorkflowId,
      path: DELIVERY_V2_SOURCE_WORKFLOW_PATH,
      state: 'active',
      trustedBaseSha: baseSha,
      blobSha: candidateWorkflow.blobSha,
      fingerprint: candidateFingerprint
    })
  });
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
  sourceWorkflowDefinition,
  sourceWorkflowEvidence,
  classifierSource,
  implementationAttempt = 1
} = {}) {
  if (!pullRequest || typeof pullRequest !== 'object') throw new Error('pullRequest is required');
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');

  const materialHeadSha = requiredSha(pullRequest.head?.sha, 'pullRequest.head.sha');
  const trustedSource = assertTrustedSourceWorkflowRun(
    sourceWorkflowRun,
    repository,
    pullRequest,
    sourceWorkflowDefinition,
    sourceWorkflowEvidence
  );

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
      name: DELIVERY_V2_SOURCE_WORKFLOW_NAME,
      required: true,
      scope: 'material-head',
      subjectSha: materialHeadSha,
      status: trustedSource.run.status,
      conclusion: trustedSource.run.conclusion,
      workflowRunId: requiredPositiveInteger(trustedSource.run.id, 'sourceWorkflowRun.id'),
      workflowEvidence: trustedSource.workflowEvidence
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
