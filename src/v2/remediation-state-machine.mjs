import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_STATES = Object.freeze([
  'queued',
  'classified',
  'implementing',
  'ci-pending',
  'ci-failed-remediable',
  'audit-pending',
  'audit-failed-remediable',
  'ready-for-human-merge',
  'escalated',
  'terminal'
]);

const STATE_SET = new Set(DELIVERY_V2_STATES);
const CI_FAILURE_CLASSES = new Set(['actionable', 'external', 'preexisting']);
const SHA_RE = /^[0-9a-f]{40}$/i;

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function requiredSha(value, label = 'materialHeadSha') {
  const sha = requiredString(value, label).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return sha;
}

function ensureState(state) {
  if (!state || typeof state !== 'object' || !STATE_SET.has(state.status)) throw new Error('invalid Delivery V2 state');
  return state;
}

function cloneFindings(findings = []) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array');
  return findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object') throw new Error(`findings[${index}] must be an object`);
    return Object.freeze({
      id: requiredString(finding.id, `findings[${index}].id`),
      candidateSha: requiredSha(finding.candidateSha, `findings[${index}].candidateSha`),
      blocksRelease: finding.blocksRelease === true,
      remediationMode: requiredString(finding.remediationMode, `findings[${index}].remediationMode`),
      surface: requiredString(finding.surface, `findings[${index}].surface`),
      failureMode: requiredString(finding.failureMode, `findings[${index}].failureMode`)
    });
  });
}

function transition(state, patch) {
  return Object.freeze({ ...state, ...patch });
}

function escalationPacket(state, reason, details = {}) {
  return Object.freeze({
    reason,
    riskProfile: state.riskProfile,
    materialHeadSha: state.materialHeadSha,
    implementationAttempts: state.implementationAttempts,
    maxImplementationAttempts: state.limits.maxImplementationAttempts,
    auditAttempts: state.auditAttempts,
    auditRemediationAttempts: state.auditRemediationAttempts,
    maxAuditRemediationAttempts: state.limits.maxAuditRemediationAttempts,
    blockingFindings: state.blockingFindings,
    ciFailure: state.ciFailure,
    ...details
  });
}

function escalate(state, reason, details = {}) {
  return transition(state, {
    status: 'escalated',
    terminalReason: reason,
    escalation: escalationPacket(state, reason, details),
    auditInFlight: false
  });
}

export function createDeliveryState({ repository, workItem, riskProfile, materialHeadSha = null } = {}) {
  const policy = executionPolicyFor(requiredString(riskProfile, 'riskProfile'));
  return Object.freeze({
    schemaVersion: 1,
    repository: requiredString(repository, 'repository'),
    workItem: requiredString(workItem, 'workItem'),
    status: 'queued',
    riskProfile: policy.profile,
    materialHeadSha: materialHeadSha ? requiredSha(materialHeadSha) : null,
    implementationAttempts: 0,
    auditAttempts: 0,
    auditRemediationAttempts: 0,
    limits: Object.freeze({
      maxImplementationAttempts: policy.maxImplementationAttempts,
      maxAuditRemediationAttempts: policy.maxAuditAttempts
    }),
    auditRequired: policy.auditRequired,
    auditMode: policy.auditMode,
    ciEvidence: null,
    auditEvidence: null,
    ciFailure: null,
    blockingFindings: Object.freeze([]),
    auditInFlight: false,
    terminalReason: null,
    escalation: null,
    controls: Object.freeze({ recursiveAiOrchestrationAllowed: false, automaticMergeAllowed: false })
  });
}

export function classifyDelivery(state, { riskProfile = state.riskProfile } = {}) {
  ensureState(state);
  if (!['queued', 'classified'].includes(state.status)) throw new Error(`cannot classify from ${state.status}`);
  const policy = executionPolicyFor(riskProfile);
  return transition(state, {
    status: 'classified',
    riskProfile: policy.profile,
    limits: Object.freeze({ maxImplementationAttempts: policy.maxImplementationAttempts, maxAuditRemediationAttempts: policy.maxAuditAttempts }),
    auditRequired: policy.auditRequired,
    auditMode: policy.auditMode,
    terminalReason: null,
    escalation: null
  });
}

export function startImplementation(state) {
  ensureState(state);
  if (!['classified', 'ci-failed-remediable', 'audit-failed-remediable'].includes(state.status)) {
    throw new Error(`cannot start implementation from ${state.status}`);
  }
  if (state.implementationAttempts >= state.limits.maxImplementationAttempts) {
    return escalate(state, 'implementation-budget-exhausted');
  }
  return transition(state, {
    status: 'implementing',
    implementationAttempts: state.implementationAttempts + 1,
    auditRemediationAttempts: state.auditRemediationAttempts + (state.status === 'audit-failed-remediable' ? 1 : 0),
    ciFailure: null,
    auditInFlight: false
  });
}

export function publishMaterial(state, { materialHeadSha } = {}) {
  ensureState(state);
  if (state.status !== 'implementing') throw new Error(`cannot publish material from ${state.status}`);
  const sha = requiredSha(materialHeadSha);
  return transition(state, {
    status: 'ci-pending',
    materialHeadSha: sha,
    ciEvidence: null,
    auditEvidence: null,
    ciFailure: null,
    blockingFindings: Object.freeze([]),
    auditInFlight: false,
    terminalReason: null,
    escalation: null
  });
}

export function recordCiResult(state, result = {}) {
  ensureState(state);
  if (state.status !== 'ci-pending') throw new Error(`cannot record CI from ${state.status}`);
  const candidateSha = requiredSha(result.candidateSha, 'CI candidateSha');
  if (candidateSha !== state.materialHeadSha) throw new Error('CI evidence is stale for current material SHA');
  const conclusion = requiredString(result.conclusion, 'CI conclusion').toLowerCase();
  if (conclusion === 'success') {
    const ciEvidence = Object.freeze({ candidateSha, conclusion: 'success', evidenceRef: requiredString(result.evidenceRef, 'CI evidenceRef') });
    return transition(state, {
      status: state.auditRequired ? 'audit-pending' : 'ready-for-human-merge',
      ciEvidence,
      ciFailure: null,
      auditInFlight: false
    });
  }
  if (conclusion !== 'failure') throw new Error('CI conclusion must be success or failure');
  const failureClass = requiredString(result.failureClass, 'CI failureClass').toLowerCase();
  if (!CI_FAILURE_CLASSES.has(failureClass)) throw new Error('CI failureClass must be actionable, external, or preexisting');
  const ciFailure = Object.freeze({
    candidateSha,
    failureClass,
    cause: requiredString(result.cause, 'CI cause'),
    evidenceRef: requiredString(result.evidenceRef, 'CI evidenceRef')
  });
  if (failureClass !== 'actionable') {
    return transition(state, { status: 'ci-pending', ciFailure, ciEvidence: null });
  }
  if (state.implementationAttempts >= state.limits.maxImplementationAttempts) {
    return escalate(transition(state, { ciFailure }), 'implementation-budget-exhausted');
  }
  return transition(state, { status: 'ci-failed-remediable', ciFailure, ciEvidence: null });
}

export function startAudit(state) {
  ensureState(state);
  if (state.status !== 'audit-pending') throw new Error(`cannot start audit from ${state.status}`);
  if (!state.auditRequired) throw new Error('audit is not required for this state');
  if (state.auditInFlight) throw new Error('audit is already in flight');
  const maxAuditRuns = state.limits.maxAuditRemediationAttempts + 1;
  if (state.auditAttempts >= maxAuditRuns) return escalate(state, 'audit-remediation-budget-exhausted');
  return transition(state, { auditAttempts: state.auditAttempts + 1, auditInFlight: true });
}

export function recordAuditResult(state, result = {}) {
  ensureState(state);
  if (state.status !== 'audit-pending' || !state.auditInFlight) throw new Error('audit result requires an in-flight audit');
  const candidateSha = requiredSha(result.candidateSha, 'audit candidateSha');
  if (candidateSha !== state.materialHeadSha) throw new Error('audit evidence is stale for current material SHA');
  const decision = requiredString(result.decision, 'audit decision').toLowerCase();
  if (decision === 'approved') {
    return transition(state, {
      status: 'ready-for-human-merge',
      auditEvidence: Object.freeze({ candidateSha, decision: 'approved', evidenceRef: requiredString(result.evidenceRef, 'audit evidenceRef') }),
      blockingFindings: Object.freeze([]),
      auditInFlight: false
    });
  }
  if (decision !== 'rejected') throw new Error('audit decision must be approved or rejected');
  const findings = cloneFindings(result.findings);
  const blocking = findings.filter((finding) => finding.blocksRelease);
  if (blocking.length === 0) throw new Error('rejected audit requires actionable release-blocking findings');
  for (const finding of blocking) {
    if (finding.candidateSha !== state.materialHeadSha) throw new Error(`finding ${finding.id} is stale for current material SHA`);
  }
  const failed = transition(state, {
    auditEvidence: Object.freeze({ candidateSha, decision: 'rejected', evidenceRef: requiredString(result.evidenceRef, 'audit evidenceRef') }),
    blockingFindings: Object.freeze(blocking),
    auditInFlight: false
  });
  if (failed.auditRemediationAttempts >= failed.limits.maxAuditRemediationAttempts) return escalate(failed, 'audit-remediation-budget-exhausted');
  if (failed.implementationAttempts >= failed.limits.maxImplementationAttempts) return escalate(failed, 'implementation-budget-exhausted-after-audit');
  return transition(failed, { status: 'audit-failed-remediable' });
}

export function remediationInputsFor(state, { newRiskSurfaces = [] } = {}) {
  ensureState(state);
  if (!['ci-failed-remediable', 'audit-failed-remediable'].includes(state.status)) throw new Error(`no remediation input for ${state.status}`);
  if (!Array.isArray(newRiskSurfaces)) throw new Error('newRiskSurfaces must be an array');
  const surfaces = newRiskSurfaces.map((item) => requiredString(item, 'newRiskSurfaces entry'));
  if (state.status === 'audit-failed-remediable') {
    return Object.freeze({
      source: 'audit-findings',
      findings: state.blockingFindings,
      newRiskSurfaces: Object.freeze(surfaces)
    });
  }
  return Object.freeze({
    source: 'ci-failure',
    ciFailure: state.ciFailure,
    newRiskSurfaces: Object.freeze(surfaces)
  });
}

export function recordHeadDrift(state, { materialHeadSha } = {}) {
  ensureState(state);
  if (['terminal', 'escalated'].includes(state.status)) throw new Error(`cannot apply head drift to ${state.status}`);
  const sha = requiredSha(materialHeadSha);
  if (sha === state.materialHeadSha) return state;
  return transition(state, {
    status: 'queued',
    materialHeadSha: sha,
    ciEvidence: null,
    auditEvidence: null,
    ciFailure: null,
    blockingFindings: Object.freeze([]),
    auditInFlight: false,
    terminalReason: 'material-sha-drift',
    escalation: null
  });
}

export function escalateDelivery(state, { reason, evidenceRef = null } = {}) {
  ensureState(state);
  if (state.status === 'terminal') throw new Error('terminal delivery cannot be escalated');
  return escalate(state, requiredString(reason, 'escalation reason'), evidenceRef ? { evidenceRef: requiredString(evidenceRef, 'evidenceRef') } : {});
}

export function markTerminal(state, { reason } = {}) {
  ensureState(state);
  if (!['ready-for-human-merge', 'escalated'].includes(state.status)) throw new Error(`cannot terminate from ${state.status}`);
  return transition(state, { status: 'terminal', terminalReason: requiredString(reason, 'terminal reason') });
}
