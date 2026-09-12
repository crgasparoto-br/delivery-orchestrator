import { createHash } from 'node:crypto';
import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_AUDIT_SCHEMA_VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const FINDING_ID_RE = /^DV2-[A-Z0-9][A-Z0-9._-]*$/;
const TERMINAL_CHECK_CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale']);
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const REMEDIATION_MODES = new Set(['targeted', 'systemic']);

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}
function requireString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}
function requirePositiveInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}
function requireSha(value, label) {
  const sha = requireString(value, label).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return sha;
}
function normalizeRepository(value) {
  const repository = requireString(value, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository must use owner/name form');
  return repository;
}
function normalizePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('changedPaths must be a non-empty array');
  return [...new Set(paths.map((value) => requireString(value, 'changedPaths entry').replaceAll('\\', '/').replace(/^\.\//, '')))];
}
function normalizeWorkflowEvidence(evidence, index) {
  const value = requireObject(evidence, `checks[${index}].workflowEvidence`);
  const state = requireString(value.state, `checks[${index}].workflowEvidence.state`).toLowerCase();
  if (state !== 'active') throw new Error(`checks[${index}].workflowEvidence.state must be active`);
  const fingerprint = requireString(value.fingerprint, `checks[${index}].workflowEvidence.fingerprint`).toLowerCase();
  if (!FINGERPRINT_RE.test(fingerprint)) throw new Error(`checks[${index}].workflowEvidence.fingerprint must be a 64-character SHA-256 fingerprint`);
  return Object.freeze({
    workflowId: requirePositiveInteger(value.workflowId, `checks[${index}].workflowEvidence.workflowId`),
    path: requireString(value.path, `checks[${index}].workflowEvidence.path`),
    state,
    trustedBaseSha: requireSha(value.trustedBaseSha, `checks[${index}].workflowEvidence.trustedBaseSha`),
    blobSha: requireSha(value.blobSha, `checks[${index}].workflowEvidence.blobSha`),
    fingerprint
  });
}
function normalizeCheck(check, index, materialHeadSha, mergePreviewSha) {
  const value = requireObject(check, `checks[${index}]`);
  const scope = requireString(value.scope, `checks[${index}].scope`).toLowerCase();
  if (!['material-head', 'merge-preview'].includes(scope)) throw new Error(`checks[${index}].scope must be material-head or merge-preview`);
  const subjectSha = requireSha(value.subjectSha, `checks[${index}].subjectSha`);
  const expectedSha = scope === 'material-head' ? materialHeadSha : mergePreviewSha;
  if (!expectedSha) throw new Error(`checks[${index}] references merge-preview without mergePreviewSha`);
  if (subjectSha !== expectedSha) throw new Error(`checks[${index}] is stale: ${scope} subject SHA does not match candidate identity`);
  const status = requireString(value.status, `checks[${index}].status`).toLowerCase();
  const conclusion = value.conclusion == null ? null : requireString(value.conclusion, `checks[${index}].conclusion`).toLowerCase();
  if (status === 'completed' && (!conclusion || !TERMINAL_CHECK_CONCLUSIONS.has(conclusion))) {
    throw new Error(`checks[${index}] completed status requires a supported conclusion`);
  }
  const workflowEvidence = value.workflowEvidence == null ? null : normalizeWorkflowEvidence(value.workflowEvidence, index);
  return Object.freeze({
    name: requireString(value.name, `checks[${index}].name`),
    required: value.required !== false,
    scope,
    subjectSha,
    status,
    conclusion,
    workflowRunId: requirePositiveInteger(value.workflowRunId, `checks[${index}].workflowRunId`),
    workflowEvidence
  });
}
function normalizePriorFinding(finding, index, materialHeadSha) {
  const value = requireObject(finding, `priorFindings[${index}]`);
  return Object.freeze({
    id: requireString(value.id, `priorFindings[${index}].id`),
    candidateSha: requireSha(value.candidateSha, `priorFindings[${index}].candidateSha`),
    sameCandidate: String(value.candidateSha).toLowerCase() === materialHeadSha,
    status: requireString(value.status, `priorFindings[${index}].status`)
  });
}

export function normalizeAuditInput(input) {
  const value = requireObject(input, 'audit input');
  if (value.schemaVersion !== DELIVERY_V2_AUDIT_SCHEMA_VERSION) throw new Error(`audit input schemaVersion must be ${DELIVERY_V2_AUDIT_SCHEMA_VERSION}`);
  const materialHeadSha = requireSha(value.materialHeadSha, 'materialHeadSha');
  const mergePreviewSha = value.mergePreviewSha == null ? null : requireSha(value.mergePreviewSha, 'mergePreviewSha');
  const risk = requireObject(value.risk, 'risk');
  const profile = requireString(risk.profile, 'risk.profile').toLowerCase();
  const policy = executionPolicyFor(profile);
  const classifier = requireObject(value.classifier, 'classifier');
  const implementer = requireObject(value.implementer, 'implementer');
  const checks = value.checks;
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('checks must be a non-empty array');
  const normalizedChecks = checks.map((check, index) => normalizeCheck(check, index, materialHeadSha, mergePreviewSha));
  if (!normalizedChecks.some((check) => check.scope === 'material-head' && check.required)) {
    throw new Error('at least one required material-head check is required');
  }
  return Object.freeze({
    schemaVersion: DELIVERY_V2_AUDIT_SCHEMA_VERSION,
    repository: normalizeRepository(value.repository),
    issueNumber: requirePositiveInteger(value.issueNumber, 'issueNumber'),
    pullRequestNumber: requirePositiveInteger(value.pullRequestNumber, 'pullRequestNumber'),
    baseRef: requireString(value.baseRef, 'baseRef'),
    baseSha: requireSha(value.baseSha, 'baseSha'),
    headRef: requireString(value.headRef, 'headRef'),
    materialHeadSha,
    mergePreviewSha,
    risk: Object.freeze({ profile, reasons: Object.freeze(Array.isArray(risk.reasons) ? risk.reasons.map((item) => requireString(item, 'risk.reasons entry')) : []) }),
    classifier: Object.freeze({
      version: requireString(classifier.version, 'classifier.version'),
      fingerprint: requireString(classifier.fingerprint, 'classifier.fingerprint')
    }),
    checks: Object.freeze(normalizedChecks),
    changedPaths: Object.freeze(normalizePaths(value.changedPaths)),
    implementationAttempt: requirePositiveInteger(value.implementationAttempt, 'implementationAttempt'),
    implementer: Object.freeze({
      provider: requireString(implementer.provider, 'implementer.provider').toLowerCase(),
      workerIdentity: requireString(implementer.workerIdentity, 'implementer.workerIdentity'),
      runId: requirePositiveInteger(implementer.runId, 'implementer.runId')
    }),
    priorFindings: Object.freeze((value.priorFindings ?? []).map((finding, index) => normalizePriorFinding(finding, index, materialHeadSha))),
    legacyV1HandoffObserved: value.legacyV1Handoff != null,
    policy: Object.freeze({ auditRequired: policy.auditRequired, auditMode: policy.auditMode, maxAuditAttempts: policy.maxAuditAttempts })
  });
}

export function auditApplicability(input, { standardAuditRequired } = {}) {
  const normalized = input?.schemaVersion === DELIVERY_V2_AUDIT_SCHEMA_VERSION && input?.materialHeadSha ? input : normalizeAuditInput(input);
  if (normalized.risk.profile === 'fast') return Object.freeze({ required: false, mode: 'none', reason: 'fast-no-mandatory-audit' });
  if (normalized.risk.profile === 'standard' && standardAuditRequired === false) {
    return Object.freeze({ required: false, mode: 'none', reason: 'standard-policy-does-not-require-audit' });
  }
  return Object.freeze({ required: true, mode: normalized.risk.profile === 'critical' ? 'independent' : 'focused-independent', reason: `${normalized.risk.profile}-audit-required` });
}

export function buildAuditRequest(input, options = {}) {
  const candidate = normalizeAuditInput(input);
  const applicability = auditApplicability(candidate, options);
  const request = {
    schemaVersion: DELIVERY_V2_AUDIT_SCHEMA_VERSION,
    candidate,
    applicability,
    reviewerContextPolicy: Object.freeze({
      includeCandidateCode: true,
      includeContract: true,
      includeGitHubEvidence: true,
      includeImplementerHiddenReasoning: false,
      legacyV1HandoffRequired: false
    })
  };
  const canonical = JSON.stringify(request);
  return Object.freeze({ ...request, requestFingerprint: createHash('sha256').update(canonical).digest('hex') });
}

function normalizeFinding(finding, index, candidateSha) {
  const value = requireObject(finding, `findings[${index}]`);
  const id = requireString(value.id, `findings[${index}].id`);
  if (!FINDING_ID_RE.test(id)) throw new Error(`findings[${index}].id must be stable and start with DV2-`);
  const severity = requireString(value.severity, `findings[${index}].severity`).toLowerCase();
  if (!SEVERITIES.has(severity)) throw new Error(`findings[${index}].severity is unsupported`);
  const remediationMode = requireString(value.remediationMode, `findings[${index}].remediationMode`).toLowerCase();
  if (!REMEDIATION_MODES.has(remediationMode)) throw new Error(`findings[${index}].remediationMode must be targeted or systemic`);
  const findingSha = requireSha(value.candidateSha, `findings[${index}].candidateSha`);
  if (findingSha !== candidateSha) throw new Error(`findings[${index}] belongs to a different material SHA`);
  return Object.freeze({
    id,
    severity,
    candidateSha: findingSha,
    violatedContract: requireString(value.violatedContract, `findings[${index}].violatedContract`),
    surface: requireString(value.surface, `findings[${index}].surface`),
    failureMode: requireString(value.failureMode, `findings[${index}].failureMode`),
    evidence: requireString(value.evidence, `findings[${index}].evidence`),
    remediationMode,
    blocksRelease: value.blocksRelease === true
  });
}

export function normalizeAuditResult(result, request) {
  const value = requireObject(result, 'audit result');
  if (value.schemaVersion !== DELIVERY_V2_AUDIT_SCHEMA_VERSION) throw new Error(`audit result schemaVersion must be ${DELIVERY_V2_AUDIT_SCHEMA_VERSION}`);
  const candidateSha = requireSha(value.candidateSha, 'audit result candidateSha');
  if (candidateSha !== request.candidate.materialHeadSha) throw new Error('audit result is stale: candidate SHA does not match request material head');
  const reviewer = requireObject(value.reviewer, 'reviewer');
  const reviewerIdentity = requireString(reviewer.workerIdentity, 'reviewer.workerIdentity');
  const reviewerRunId = requirePositiveInteger(reviewer.runId, 'reviewer.runId');
  const contextIsolation = requireString(reviewer.contextIsolation, 'reviewer.contextIsolation');
  if (request.applicability.required && contextIsolation !== 'candidate-contract-evidence-only') {
    throw new Error('required audit must attest candidate-contract-evidence-only context isolation');
  }
  if (request.applicability.mode === 'independent') {
    if (reviewerIdentity === request.candidate.implementer.workerIdentity || reviewerRunId === request.candidate.implementer.runId) {
      throw new Error('CRITICAL audit reviewer must be independent from the implementation worker/run');
    }
  }
  const decision = requireString(value.decision, 'decision').toLowerCase();
  if (!['approved', 'rejected', 'not-required'].includes(decision)) throw new Error('decision must be approved, rejected, or not-required');
  if (request.applicability.required && decision === 'not-required') throw new Error('required audit cannot return not-required');
  if (!request.applicability.required && decision !== 'not-required' && value.allowOptionalAudit !== true) {
    throw new Error('non-required audit must return not-required unless explicitly executed as optional audit');
  }
  const findings = (value.findings ?? []).map((finding, index) => normalizeFinding(finding, index, candidateSha));
  const ids = new Set();
  for (const finding of findings) {
    if (ids.has(finding.id)) throw new Error(`duplicate finding id: ${finding.id}`);
    ids.add(finding.id);
  }
  if (decision === 'approved' && findings.some((finding) => finding.blocksRelease)) throw new Error('approved audit cannot contain release-blocking findings');
  if (decision === 'rejected' && !findings.some((finding) => finding.blocksRelease)) throw new Error('rejected audit requires at least one release-blocking finding');
  return Object.freeze({
    schemaVersion: DELIVERY_V2_AUDIT_SCHEMA_VERSION,
    candidateSha,
    decision,
    reviewer: Object.freeze({
      provider: requireString(reviewer.provider, 'reviewer.provider').toLowerCase(),
      workerIdentity: reviewerIdentity,
      runId: reviewerRunId,
      contextIsolation
    }),
    findings: Object.freeze(findings),
    requestFingerprint: requireString(value.requestFingerprint, 'requestFingerprint')
  });
}

export function evaluateAuditOutcome(request, result) {
  if (!request.applicability.required && !result) return Object.freeze({ status: 'not-required', releaseBlocked: false, findings: [] });
  if (request.applicability.required && !result) return Object.freeze({ status: 'pending', releaseBlocked: true, findings: [] });
  const normalized = normalizeAuditResult(result, request);
  if (normalized.requestFingerprint !== request.requestFingerprint) throw new Error('audit result requestFingerprint does not match the exact audit request');
  const blocking = normalized.findings.filter((finding) => finding.blocksRelease);
  return Object.freeze({
    status: normalized.decision,
    releaseBlocked: normalized.decision === 'rejected' || blocking.length > 0,
    findings: normalized.findings,
    candidateSha: normalized.candidateSha
  });
}
