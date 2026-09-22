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
import { resolveProviderSelectionForRisk } from './provider-policy.mjs';
import { evaluateReleaseGate } from './release-gate.mjs';
import { normalizeTechnicalHygieneResult } from './technical-hygiene.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const RISK_RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });
const AI_POLICY_ENV_KEYS = Object.freeze([
  'DELIVERY_AI_PROVIDER',
  'DELIVERY_AI_MODEL',
  'DELIVERY_IMPLEMENTER_PROVIDER',
  'DELIVERY_IMPLEMENTER_MODEL',
  'DELIVERY_AUDITOR_PROVIDER',
  'DELIVERY_AUDITOR_MODEL',
  'DELIVERY_FAST_IMPLEMENTER_PROVIDER',
  'DELIVERY_FAST_IMPLEMENTER_MODEL',
  'DELIVERY_STANDARD_IMPLEMENTER_PROVIDER',
  'DELIVERY_STANDARD_IMPLEMENTER_MODEL',
  'DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER',
  'DELIVERY_CRITICAL_IMPLEMENTER_MODEL',
  'DELIVERY_STANDARD_AUDITOR_PROVIDER',
  'DELIVERY_STANDARD_AUDITOR_MODEL',
  'DELIVERY_CRITICAL_AUDITOR_PROVIDER',
  'DELIVERY_CRITICAL_AUDITOR_MODEL'
]);

function requiredObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function optionalString(value) {
  const resolved = String(value ?? '').trim();
  return resolved || null;
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

function aiPolicyFromEnv(env = process.env) {
  return {
    provider: env.DELIVERY_AI_PROVIDER,
    model: env.DELIVERY_AI_MODEL,
    implementerProvider: env.DELIVERY_IMPLEMENTER_PROVIDER,
    implementerModel: env.DELIVERY_IMPLEMENTER_MODEL,
    auditorProvider: env.DELIVERY_AUDITOR_PROVIDER,
    auditorModel: env.DELIVERY_AUDITOR_MODEL,
    fastImplementerProvider: env.DELIVERY_FAST_IMPLEMENTER_PROVIDER,
    fastImplementerModel: env.DELIVERY_FAST_IMPLEMENTER_MODEL,
    standardImplementerProvider: env.DELIVERY_STANDARD_IMPLEMENTER_PROVIDER,
    standardImplementerModel: env.DELIVERY_STANDARD_IMPLEMENTER_MODEL,
    criticalImplementerProvider: env.DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER,
    criticalImplementerModel: env.DELIVERY_CRITICAL_IMPLEMENTER_MODEL,
    standardAuditorProvider: env.DELIVERY_STANDARD_AUDITOR_PROVIDER,
    standardAuditorModel: env.DELIVERY_STANDARD_AUDITOR_MODEL,
    criticalAuditorProvider: env.DELIVERY_CRITICAL_AUDITOR_PROVIDER,
    criticalAuditorModel: env.DELIVERY_CRITICAL_AUDITOR_MODEL
  };
}

function hasRuntimeAiPolicy(env = process.env) {
  return AI_POLICY_ENV_KEYS.some((key) => optionalString(env[key]) != null);
}

function resolveStateAiIdentity(current, target, env = process.env) {
  const runtime = hasRuntimeAiPolicy(env)
    ? resolveProviderSelectionForRisk(aiPolicyFromEnv(env), current.riskProfile)
    : null;
  return Object.freeze({
    provider: runtime?.implementer.provider ?? optionalString(current.implementerProvider) ?? requiredString(target.provider, 'identity.provider'),
    model: runtime?.implementer.model ?? optionalString(current.implementerModel) ?? optionalString(target.model),
    auditorProvider: runtime?.auditor.provider ?? optionalString(current.auditorProvider) ?? optionalString(target.auditorProvider),
    auditorModel: runtime?.auditor.model ?? optionalString(current.auditorModel) ?? optionalString(target.auditorModel)
  });
}

function bindPlanAiIdentity(state, plan) {
  const implementation = requiredObject(plan.implementation, 'plan.implementation');
  const audit = requiredObject(plan.audit, 'plan.audit');
  return Object.freeze({
    ...state,
    implementerProvider: requiredString(implementation.provider, 'plan.implementation.provider'),
    implementerModel: requiredString(implementation.model, 'plan.implementation.model'),
    auditorProvider: requiredString(audit.provider, 'plan.audit.provider'),
    auditorModel: requiredString(audit.model, 'plan.audit.model')
  });
}

function promoteOperationalRisk(state, plan) {
  const value = requiredObject(plan, 'plan');
  const profile = requiredString(value.risk?.profile, 'plan.risk.profile');
  if (!(profile in RISK_RANK)) throw new Error(`unsupported promoted risk profile: ${profile}`);
  if (RISK_RANK[profile] < RISK_RANK[state.riskProfile]) throw new Error('technical hygiene promotion cannot downgrade risk');
  if (RISK_RANK[profile] === RISK_RANK[state.riskProfile]) return state;
  const policy = executionPolicyFor(profile);
  let next = Object.freeze({
    ...state,
    riskProfile: profile,
    limits: Object.freeze({ maxImplementationAttempts: policy.maxImplementationAttempts, maxAuditRemediationAttempts: policy.maxAuditAttempts })
  });
  next = applyAuditPolicy(next, { repository: value.repository, audit: requiredObject(value.audit, 'plan.audit') });
  return bindPlanAiIdentity(next, value);
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
  state = bindPlanAiIdentity(state, value);
  if (materialHeadSha == null) return Object.freeze({ ...state, technicalHygiene: null });
  state = startImplementation(state);
  state = publishMaterial(state, { materialHeadSha: requiredSha(materialHeadSha, 'materialHeadSha') });
  return Object.freeze({ ...state, technicalHygiene: null });
}

export function createAdoptedOperationalDelivery({ plan, materialHeadSha, ciEvidence } = {}) {
  const value = requiredObject(plan, 'plan');
  if (value.architecture !== 'github-native-v2') throw new Error('Expected github-native-v2 delivery plan');

  const sha = requiredSha(materialHeadSha, 'materialHeadSha');
  const evidence = requiredObject(ciEvidence, 'ciEvidence');

  let state = createDeliveryState({
    repository: requiredString(value.repository, 'plan.repository'),
    workItem: `issue:${requiredPositiveInteger(value.issueNumber, 'plan.issueNumber')}`,
    riskProfile: requiredString(value.risk?.profile, 'plan.risk.profile'),
    materialHeadSha: sha
  });

  state = classifyDelivery(state, { riskProfile: value.risk.profile });
  state = applyAuditPolicy(state, {
    repository: value.repository,
    audit: requiredObject(value.audit, 'plan.audit')
  });
  state = bindPlanAiIdentity(state, value);

  // This material existed before Delivery V2 adopted the PR. Do not call
  // startImplementation/publishMaterial: doing so would fabricate an
  // implementation attempt. CI was already validated exact-head by the
  // adoption refreeze and is imported explicitly as the first operational
  // evidence of the new post-adoption epoch.
  state = Object.freeze({
    ...state,
    status: 'ci-pending',
    materialHeadSha: sha,
    technicalHygiene: null
  });

  state = recordCiResult(state, {
    candidateSha: sha,
    conclusion: 'success',
    evidenceRef: requiredString(evidence.evidenceRef, 'ciEvidence.evidenceRef')
  });

  return reconcileTechnicalHygieneReadiness(Object.freeze({ ...state, technicalHygiene: null }));
}

function reconcileTechnicalHygieneReadiness(state) {
  const hygiene = state.technicalHygiene;

  // A proven hygiene BLOCK is actionable material failure. Preserve the
  // existing bounded implementation-remediation path instead of converting
  // it into human escalation. When CI has just completed for an audit-required
  // candidate, route before allocating an audit run.
  if (
    hygiene?.materialSha === state.materialHeadSha &&
    hygiene.result === 'BLOCK' &&
    (
      state.status === 'ready-for-human-merge' ||
      state.status === 'technical-hygiene-pending' ||
      (state.status === 'audit-pending' && !state.auditInFlight)
    )
  ) {
    return Object.freeze({
      ...state,
      status: 'ci-failed-remediable',
      ciFailure: Object.freeze({
        candidateSha: state.materialHeadSha,
        failureClass: 'actionable',
        cause: 'technical-hygiene-block',
        evidenceRef: hygiene.evidenceRef
      }),
      auditInFlight: false
    });
  }

  if (!['ready-for-human-merge', 'technical-hygiene-pending'].includes(state.status)) return state;

  const passed = hygiene?.materialSha === state.materialHeadSha &&
    ['PASS', 'PASS_WITH_DEBT'].includes(hygiene.result) &&
    !hygiene.promotionRequired &&
    !hygiene.missingEvidence.some((item) => item.material);

  return Object.freeze({
    ...state,
    status: passed
      ? (state.auditRequired && state.auditEvidence?.decision !== 'approved'
        ? 'audit-pending'
        : 'ready-for-human-merge')
      : 'technical-hygiene-pending'
  });
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
    case 'technical-hygiene-pending': return 'resolve-technical-hygiene';
    case 'escalated': return 'human-escalation';
    case 'terminal': return 'done';
    default: throw new Error(`unsupported Delivery V2 state: ${state?.status ?? '(missing)'}`);
  }
}

export function applyOperationalEvent(state, event) {
  const value = requiredObject(event, 'event');
  switch (requiredString(value.type, 'event.type')) {
    case 'classify': return classifyDelivery(state, { riskProfile: value.riskProfile ?? state.riskProfile });
    case 'promote-risk': return promoteOperationalRisk(state, requiredObject(value.plan, 'event.plan'));
    case 'start-implementation': return startImplementation(state);
    case 'publish-material': return Object.freeze({ ...publishMaterial(state, { materialHeadSha: value.materialHeadSha }), technicalHygiene: null });
    case 'technical-hygiene-result': {
      const technicalHygiene = normalizeTechnicalHygieneResult(value.result);
      if (technicalHygiene.materialSha !== state.materialHeadSha) throw new Error('technical hygiene result is stale for material head');
      return reconcileTechnicalHygieneReadiness(Object.freeze({ ...state, technicalHygiene }));
    }
    case 'resolve-technical-hygiene': {
      const next = reconcileTechnicalHygieneReadiness(state);
      if (next.status !== 'technical-hygiene-pending') return next;
      return escalateDelivery(next, {
        reason: `technical-hygiene-${next.technicalHygiene?.result?.toLowerCase() ?? 'missing'}`,
        evidenceRef: next.technicalHygiene?.evidenceRef
      });
    }
    case 'ci-result': return reconcileTechnicalHygieneReadiness(recordCiResult(state, value.result));
    case 'start-audit': return startAudit(state);
    case 'audit-result': {
      const inFlight = state.auditInFlight ? state : startAudit(state);
      return reconcileTechnicalHygieneReadiness(recordAuditResult(inFlight, value.result));
    }
    case 'head-drift': return Object.freeze({ ...recordHeadDrift(state, { materialHeadSha: value.materialHeadSha }), technicalHygiene: null });
    case 'escalate': return escalateDelivery(state, { reason: value.reason, evidenceRef: value.evidenceRef ?? null });
    case 'terminal': return markTerminal(state, { reason: value.reason });
    default: throw new Error(`unsupported operational event: ${value.type}`);
  }
}

export function operationalRemediationInput(state, options = {}) {
  const input = remediationInputsFor(state, options);

  if (
    state.status === 'ci-failed-remediable' &&
    state.ciFailure?.cause === 'technical-hygiene-block' &&
    state.technicalHygiene?.result === 'BLOCK'
  ) {
    return Object.freeze({
      ...input,
      technicalHygiene: state.technicalHygiene
    });
  }

  return input;
}

export function persistentStateFromOperational({ state, identity, classifier, workflowChecks = [], evidenceRefs = [] } = {}) {
  const current = requiredObject(state, 'state');
  const target = requiredObject(identity, 'identity');
  const classification = requiredObject(classifier, 'classifier');
  const materialHeadSha = requiredSha(current.materialHeadSha, 'state.materialHeadSha');
  const aiIdentity = resolveStateAiIdentity(current, target);
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
    provider: aiIdentity.provider,
    model: aiIdentity.model,
    auditorProvider: aiIdentity.auditorProvider,
    auditorModel: aiIdentity.auditorModel,
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
    status: persistent.status === 'ready-for-human-merge' ? 'technical-hygiene-pending' : persistent.status,
    riskProfile: persistent.effectiveRisk,
    materialHeadSha: persistent.materialHeadSha,
    implementerProvider: persistent.provider,
    implementerModel: persistent.model,
    auditorProvider: persistent.auditorProvider,
    auditorModel: persistent.auditorModel,
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
    technicalHygiene: null,
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
  const release = evaluateReleaseGate({ ...releaseInput, technicalHygieneRequired: true, technicalHygiene: current.technicalHygiene ?? null });
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
