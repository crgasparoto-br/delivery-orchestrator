import { createHash } from 'node:crypto';
import { buildAuditRequest, evaluateAuditOutcome } from './audit-contract.mjs';
import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_GITHUB_AUDITOR_IDENTITY = 'delivery-v2-github-native-auditor';
const SHA_RE = /^[0-9a-f]{40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;

function requiredObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}
function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
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
function requiredFingerprint(value, label) {
  const result = requiredString(value, label).toLowerCase();
  if (!FINGERPRINT_RE.test(result)) throw new Error(`${label} must be a 64-character SHA-256 fingerprint`);
  return result;
}

export function fingerprintSource(source) {
  return createHash('sha256').update(requiredString(source, 'source')).digest('hex');
}

export function assertTrustedAuditPullRequest(pullRequest, repository) {
  const pr = requiredObject(pullRequest, 'pullRequest');
  const expected = requiredString(repository, 'repository');
  if (requiredString(pr.head?.repo?.full_name, 'pullRequest.head.repo.full_name') !== expected) {
    throw new Error('audited PR head repository must match target repository');
  }
  if (requiredString(pr.base?.repo?.full_name, 'pullRequest.base.repo.full_name') !== expected) {
    throw new Error('audited PR base repository must match target repository');
  }
  requiredSha(pr.head?.sha, 'pullRequest.head.sha');
  requiredSha(pr.base?.sha, 'pullRequest.base.sha');
  return pr;
}

function normalizeWorkflowFileEvidence(value, label, { workflowPath, expectedRef }) {
  const evidence = requiredObject(value, label);
  if (requiredString(evidence.path, `${label}.path`) !== workflowPath) throw new Error(`${label}.path must be ${workflowPath}`);
  if (requiredSha(evidence.ref, `${label}.ref`) !== expectedRef) throw new Error(`${label}.ref does not match expected Git SHA`);
  return Object.freeze({
    ref: expectedRef,
    path: workflowPath,
    blobSha: requiredSha(evidence.blobSha, `${label}.blobSha`),
    content: requiredString(evidence.content, `${label}.content`)
  });
}

export function assertTrustedAuditSource({ repository, pullRequest, sourceWorkflowRun, sourceWorkflowDefinition, sourceWorkflowEvidence, workflowName, workflowPath } = {}) {
  const target = requiredString(repository, 'repository');
  const pr = assertTrustedAuditPullRequest(pullRequest, target);
  const run = requiredObject(sourceWorkflowRun, 'sourceWorkflowRun');
  const definition = requiredObject(sourceWorkflowDefinition, 'sourceWorkflowDefinition');
  const sourceName = requiredString(workflowName, 'workflowName');
  const sourcePath = requiredString(workflowPath, 'workflowPath');
  const headSha = requiredSha(pr.head.sha, 'pullRequest.head.sha');
  const baseSha = requiredSha(pr.base.sha, 'pullRequest.base.sha');

  if (requiredString(run.name, 'sourceWorkflowRun.name') !== sourceName) throw new Error('source workflow name does not match target policy');
  if (requiredString(run.event, 'sourceWorkflowRun.event').toLowerCase() !== 'pull_request') throw new Error('source workflow must be a pull_request run');
  if (requiredString(run.repository?.full_name, 'sourceWorkflowRun.repository.full_name') !== target) throw new Error('source workflow repository mismatch');
  if (requiredSha(run.head_sha, 'sourceWorkflowRun.head_sha') !== headSha) throw new Error('source workflow is stale for audited head');
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('source workflow must be terminal green');
  if (requiredString(run.path, 'sourceWorkflowRun.path') !== sourcePath) throw new Error('source workflow path does not match target policy');
  if (requiredString(definition.name, 'sourceWorkflowDefinition.name') !== sourceName) throw new Error('workflow definition name mismatch');
  if (requiredString(definition.path, 'sourceWorkflowDefinition.path') !== sourcePath) throw new Error('workflow definition path mismatch');
  if (requiredString(definition.state, 'sourceWorkflowDefinition.state').toLowerCase() !== 'active') throw new Error('workflow definition must be active');
  if (requiredPositiveInteger(run.workflow_id, 'sourceWorkflowRun.workflow_id') !== requiredPositiveInteger(definition.id, 'sourceWorkflowDefinition.id')) {
    throw new Error('workflow id mismatch');
  }

  const evidence = requiredObject(sourceWorkflowEvidence, 'sourceWorkflowEvidence');
  const candidate = normalizeWorkflowFileEvidence(evidence.candidate, 'sourceWorkflowEvidence.candidate', { workflowPath: sourcePath, expectedRef: headSha });
  const trustedBase = normalizeWorkflowFileEvidence(evidence.trustedBase, 'sourceWorkflowEvidence.trustedBase', { workflowPath: sourcePath, expectedRef: baseSha });
  if (candidate.blobSha !== trustedBase.blobSha) throw new Error('candidate CI workflow differs from trusted base workflow');
  if (fingerprintSource(candidate.content) !== fingerprintSource(trustedBase.content)) throw new Error('candidate CI workflow bytes differ from trusted base workflow');

  return Object.freeze({
    run,
    workflowEvidence: Object.freeze({
      workflowId: requiredPositiveInteger(run.workflow_id, 'sourceWorkflowRun.workflow_id'),
      path: sourcePath,
      state: 'active',
      trustedBaseSha: baseSha,
      blobSha: candidate.blobSha,
      fingerprint: fingerprintSource(candidate.content)
    })
  });
}

export function buildGithubNativeAuditRequest({
  repository,
  issueNumber,
  pullRequest,
  changedPaths,
  riskProfile,
  riskReasons = [],
  classifier,
  sourceWorkflowRun,
  sourceWorkflowDefinition,
  sourceWorkflowEvidence,
  workflowName,
  workflowPath,
  implementationAttempt = 1,
  implementer = null,
  priorFindings = []
} = {}) {
  const pr = assertTrustedAuditPullRequest(pullRequest, repository);
  const profile = requiredString(riskProfile, 'riskProfile').toLowerCase();
  executionPolicyFor(profile);
  const classification = requiredObject(classifier, 'classifier');
  const trusted = assertTrustedAuditSource({
    repository,
    pullRequest: pr,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowEvidence,
    workflowName,
    workflowPath
  });
  const headSha = requiredSha(pr.head.sha, 'pullRequest.head.sha');
  const mergePreviewSha = SHA_RE.test(String(pr.merge_commit_sha ?? '')) ? String(pr.merge_commit_sha).toLowerCase() : null;
  const worker = implementer ?? {
    provider: 'github',
    workerIdentity: `github-pr-author:${requiredString(pr.user?.login, 'pullRequest.user.login')}`,
    runId: requiredPositiveInteger(pr.number, 'pullRequest.number')
  };

  return buildAuditRequest({
    schemaVersion: 1,
    repository: requiredString(repository, 'repository'),
    issueNumber: requiredPositiveInteger(issueNumber, 'issueNumber'),
    pullRequestNumber: requiredPositiveInteger(pr.number, 'pullRequest.number'),
    baseRef: requiredString(pr.base.ref, 'pullRequest.base.ref'),
    baseSha: requiredSha(pr.base.sha, 'pullRequest.base.sha'),
    headRef: requiredString(pr.head.ref, 'pullRequest.head.ref'),
    materialHeadSha: headSha,
    mergePreviewSha,
    risk: { profile, reasons: riskReasons },
    classifier: {
      version: requiredString(classification.version, 'classifier.version'),
      fingerprint: requiredFingerprint(classification.fingerprint, 'classifier.fingerprint')
    },
    checks: [{
      name: requiredString(workflowName, 'workflowName'),
      required: true,
      scope: 'material-head',
      subjectSha: headSha,
      status: trusted.run.status,
      conclusion: trusted.run.conclusion,
      workflowRunId: requiredPositiveInteger(trusted.run.id, 'sourceWorkflowRun.id'),
      workflowEvidence: trusted.workflowEvidence
    }],
    changedPaths,
    implementationAttempt,
    implementer: worker,
    priorFindings
  });
}

export function githubNativeAuditOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'findings'],
    properties: {
      decision: { enum: ['approved', 'rejected'] },
      findings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
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

export function finalizeGithubNativeAuditResult({ request, modelResult, reviewerRunId, provider = 'codex', workerIdentity = DELIVERY_V2_GITHUB_AUDITOR_IDENTITY } = {}) {
  const result = Object.freeze({
    schemaVersion: 1,
    candidateSha: requiredSha(request?.candidate?.materialHeadSha, 'request.candidate.materialHeadSha'),
    decision: requiredString(modelResult?.decision, 'modelResult.decision').toLowerCase(),
    requestFingerprint: requiredString(request?.requestFingerprint, 'request.requestFingerprint'),
    reviewer: Object.freeze({
      provider: requiredString(provider, 'provider').toLowerCase(),
      workerIdentity: requiredString(workerIdentity, 'workerIdentity'),
      runId: requiredPositiveInteger(reviewerRunId, 'reviewerRunId'),
      contextIsolation: 'candidate-contract-evidence-only'
    }),
    findings: Object.freeze((modelResult?.findings ?? []).map((finding) => Object.freeze({ ...finding, candidateSha: request.candidate.materialHeadSha })))
  });
  return Object.freeze({ result, outcome: evaluateAuditOutcome(request, result) });
}
