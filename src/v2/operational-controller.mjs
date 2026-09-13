import {
  classifyDelivery,
  createDeliveryState,
  escalateDelivery,
  markTerminal,
  publishMaterial,
  recordAuditResult,
  recordCiResult,
  recordHeadDrift,
  remediationInputsFor,
  startAudit,
  startImplementation
} from './remediation-state-machine.mjs';
import { createPersistentDeliveryState, normalizePersistentDeliveryState } from './persistent-state.mjs';
import { resolveOperationalAuditPolicy } from './audit-policy.mjs';
import { executionPolicyFor } from './execution-policy.mjs';
import { evaluateReleaseGate } from './release-gate.mjs';

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

function applyAuditPolicy(state, { repository, audit } = {}) {
  const auditPolicy = audit
    ? Object.freeze({ required: audit.required === true, mode: audit.required === true ? requiredString(audit.mode, 'plan.audit.mode') : 'none' })
    : resolveOperationalAuditPolicy({ riskProfile: state.riskProfile, repository });
  return Object.freeze({ ...state, auditRequired: auditPolicy.required, auditMode: auditPolicy.mode });
}

export function createOperationalDelivery({ plan, materialHeadSha } = {}) {
  const value = requiredObject(plan, 'plan');
  if (value.architecture !== 'github-native-v2') throw new Error('Expected github-native-v2 delivery plan');
  let state = createDeliveryState({
    repository: requiredString(value.repository, 'plan.repository'),
    workItem: `issue:${requiredPositiveInteger(value.issueNumber, 'plan.issueNumber')}`,
    riskProfile: requiredString(value.risk?.profile, 'plan.risk.profile')
  });
  state = classifyDelivery(state, { riskProfile: value.risk.profile });
  state = applyAuditPolicy(state, { repository: value.repository, audit: requiredObject(value.audit, 'plan.audit') });
  if (materialHeadSha == null) return state;
  state = startImplementation(state);
  return publishMaterial(state, { materialHeadSha: requiredSha(materialHeadSha, 'materialHeadSha') });
}

export function nextOperationalAction(state) {
  switch (state?.status) {
    case 'queued': return 'classify';
    case 'classified': return 'dispatch-implementation';
    case 'implementing': return 'await-material-head';
    case 'ci-pending': return 'observe-ci';
    case 'ci-failed-remediable': return 'dispatch-ci-remediation';
    case 'audit-pending': return state.auditInFlight ? 'observe-audit' : 'dispatch-audit';
    case 'audit-failed-remediable': return 'dispatch-audit-remediation';
    case 'ready-for-human-merge': return 'evaluate-release-gate';
    case 'escalated': return 'human-escalation';
    case 'terminal': return 'done';
    default: throw new Error(`unsupported Delivery V2 state: ${state?.status ?? '(missing)'}`);
  }
}

export function applyOperationalEvent(state, event) {
  const value = requiredObject(event, 'event');
  switch (requiredString(value.type, 'event.type')) {
    case 'classify': return classifyDelivery(state, { riskProfile: value.riskProfile ?? state.riskProfile });
    case 'start-implementation': return startImplementation(state);
    case 'publish-material': return publishMaterial(state, { materialHeadSha: value.materialHeadSha });
    case 'ci-result': return recordCiResult(state, value.result);
    case 'start-audit': return startAudit(state);
    case 'audit-result': {
      const inFlight = state.auditInFlight ? state : startAudit(state);
      return recordAuditResult(inFlight, value.result);
    }
    case 'head-drift': return recordHeadDrift(state, { materialHeadSha: value.materialHeadSha });
    case 'escalate': return escalateDelivery(state, { reason: value.reason, evidenceRef: value.evidenceRef ?? null });
    case 'terminal': return markTerminal(state, { reason: value.reason });
    default: throw new Error(`unsupported operational event: ${value.type}`);
  }
}

export function operationalRemediationInput(state, options = {}) {
  return remediationInputsFor(state, options);
}

export function persistentStateFromOperational({ state, identity, classifier, workflowChecks = [], evidenceRefs = [] } = {}) {
  const current = requiredObject(state, 'state');
  const target = requiredObject(identity, 'identity');
  const classification = requiredObject(classifier, 'classifier');
  const materialHeadSha = requiredSha(current.materialHeadSha, 'state.materialHeadSha');
  return createPersistentDeliveryState({
    repository: current.repository,
    issueNumber: requiredPositiveInteger(target.issueNumber, 'identity.issueNumber'),
    pullRequestNumber: requiredPositiveInteger(target.pullRequestNumber, 'identity.pullRequestNumber'),
    baseRef: requiredString(target.baseRef, 'identity.baseRef'),
    baseSha: requiredSha(target.baseSha, 'identity.baseSha'),
    headRef: requiredString(target.headRef, 'identity.headRef'),
    materialHeadSha,
    effectiveRisk: current.riskProfile,
    classifier: {
      subjectSha: materialHeadSha,
      version: requiredString(classification.version, 'classifier.version'),
      fingerprint: requiredString(classification.fingerprint, 'classifier.fingerprint'),
      current: true
    },
    provider: requiredString(target.provider, 'identity.provider'),
    status: current.status,
    attempts: {
      implementation: current.implementationAttempts,
      audit: current.auditAttempts,
      auditRemediation: current.auditRemediationAttempts
    },
    workflowChecks,
    ciFailure: current.ciFailure,
    auditEvidence: current.auditEvidence,
    blockingFindings: (current.blockingFindings ?? []).map((finding) => ({
      id: finding.id,
      candidateSha: finding.candidateSha,
      severity: finding.severity,
      violatedContract: finding.violatedContract,
      surface: finding.surface,
      failureMode: finding.failureMode,
      evidence: finding.evidence,
      remediationMode: finding.remediationMode,
      blocksRelease: finding.blocksRelease,
      evidenceRef: current.auditEvidence?.evidenceRef ?? 'delivery-v2:operational-state'
    })),
    evidenceRefs,
    lastReason: current.terminalReason
  });
}

export function operationalStateFromPersistent(rawPersistentState) {
  const persistent = normalizePersistentDeliveryState(rawPersistentState);
  const policy = executionPolicyFor(persistent.effectiveRisk);
  const auditPolicy = resolveOperationalAuditPolicy({ riskProfile: persistent.effectiveRisk, repository: persistent.repository });
  const successfulCheck = persistent.workflowChecks.find((check) => check.subjectSha === persistent.materialHeadSha && check.status === 'completed' && check.conclusion === 'success');
  return Object.freeze({
    schemaVersion: 1,
    repository: persistent.repository,
    workItem: `issue:${persistent.issueNumber ?? 'unknown'}`,
    status: persistent.status,
    riskProfile: persistent.effectiveRisk,
    materialHeadSha: persistent.materialHeadSha,
    implementationAttempts: persistent.attempts.implementation,
    auditAttempts: persistent.attempts.audit,
    auditRemediationAttempts: persistent.attempts.auditRemediation,
    limits: Object.freeze({
      maxImplementationAttempts: policy.maxImplementationAttempts,
      maxAuditRemediationAttempts: policy.maxAuditAttempts
    }),
    auditRequired: auditPolicy.required,
    auditMode: auditPolicy.mode,
    ciEvidence: successfulCheck ? Object.freeze({ candidateSha: persistent.materialHeadSha, conclusion: 'success', evidenceRef: successfulCheck.evidenceRef }) : null,
    auditEvidence: persistent.auditEvidence,
    ciFailure: persistent.ciFailure,
    blockingFindings: Object.freeze(persistent.blockingFindings.map((finding) => Object.freeze({
      id: finding.id,
      candidateSha: finding.candidateSha,
      severity: finding.severity,
      violatedContract: finding.violatedContract,
      blocksRelease: finding.blocksRelease,
      remediationMode: finding.remediationMode,
      surface: finding.surface,
      failureMode: finding.failureMode,
      evidence: finding.evidence
    }))),
    auditInFlight: false,
    terminalReason: persistent.lastReason,
    escalation: null,
    controls: Object.freeze({ recursiveAiOrchestrationAllowed: false, automaticMergeAllowed: false })
  });
}

export function evaluateOperationalRelease({ state, releaseInput } = {}) {
  const current = requiredObject(state, 'state');
  if (current.status !== 'ready-for-human-merge') {
    return Object.freeze({
      readiness: false,
      state: current.status,
      reasons: Object.freeze([`operational-state:${current.status}`]),
      nextAction: nextOperationalAction(current),
      release: null
    });
  }
  const release = evaluateReleaseGate(releaseInput);
  if (release.candidateSha !== current.materialHeadSha) {
    throw new Error('release gate candidate does not match operational material head');
  }
  return Object.freeze({
    readiness: release.readiness,
    state: release.state,
    reasons: release.reasons,
    nextAction: release.readiness ? 'human-merge-policy' : release.state,
    release
  });
}
