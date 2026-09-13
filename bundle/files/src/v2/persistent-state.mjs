import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { executionPolicyFor } from './execution-policy.mjs';
import { DELIVERY_V2_STATES } from './remediation-state-machine.mjs';

export const DELIVERY_V2_PERSISTENT_STATE_SCHEMA_VERSION = 1;

const SHA_RE = /^[0-9a-f]{40}$/i;
const STATE_SET = new Set(DELIVERY_V2_STATES);

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
  const floor = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < floor) throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
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

function normalizeStatus(value) {
  const status = requireString(value, 'status');
  if (!STATE_SET.has(status)) throw new Error(`unsupported Delivery V2 status: ${status}`);
  return status;
}

function normalizeAttempts(value) {
  const attempts = requireObject(value, 'attempts');
  return Object.freeze({
    implementation: requirePositiveInteger(attempts.implementation, 'attempts.implementation', { allowZero: true }),
    audit: requirePositiveInteger(attempts.audit, 'attempts.audit', { allowZero: true }),
    auditRemediation: requirePositiveInteger(attempts.auditRemediation, 'attempts.auditRemediation', { allowZero: true })
  });
}

function normalizeClassifier(value, materialHeadSha) {
  const classifier = requireObject(value, 'classifier');
  const subjectSha = requireSha(classifier.subjectSha, 'classifier.subjectSha');
  return Object.freeze({
    subjectSha,
    version: requireString(classifier.version, 'classifier.version'),
    fingerprint: requireString(classifier.fingerprint, 'classifier.fingerprint'),
    current: classifier.current !== false && subjectSha === materialHeadSha
  });
}

function normalizeCheck(check, index) {
  const value = requireObject(check, `workflowChecks[${index}]`);
  return Object.freeze({
    name: requireString(value.name, `workflowChecks[${index}].name`),
    subjectSha: requireSha(value.subjectSha, `workflowChecks[${index}].subjectSha`),
    status: requireString(value.status, `workflowChecks[${index}].status`).toLowerCase(),
    conclusion: value.conclusion == null ? null : requireString(value.conclusion, `workflowChecks[${index}].conclusion`).toLowerCase(),
    workflowRunId: value.workflowRunId == null ? null : requirePositiveInteger(value.workflowRunId, `workflowChecks[${index}].workflowRunId`),
    evidenceRef: requireString(value.evidenceRef, `workflowChecks[${index}].evidenceRef`)
  });
}

function normalizeFinding(finding, index) {
  const value = requireObject(finding, `blockingFindings[${index}]`);
  return Object.freeze({
    id: requireString(value.id, `blockingFindings[${index}].id`),
    candidateSha: requireSha(value.candidateSha, `blockingFindings[${index}].candidateSha`),
    surface: requireString(value.surface, `blockingFindings[${index}].surface`),
    failureMode: requireString(value.failureMode, `blockingFindings[${index}].failureMode`),
    evidenceRef: requireString(value.evidenceRef, `blockingFindings[${index}].evidenceRef`)
  });
}

function normalizeEvidenceRefs(value = []) {
  if (!Array.isArray(value)) throw new Error('evidenceRefs must be an array');
  return Object.freeze([...new Set(value.map((item) => requireString(item, 'evidenceRefs entry')))]);
}

function normalizeAppliedIds(value = []) {
  if (!Array.isArray(value)) throw new Error('appliedTransitionIds must be an array');
  return Object.freeze([...new Set(value.map((item) => requireString(item, 'appliedTransitionIds entry')))]);
}

export function normalizePersistentDeliveryState(rawState) {
  const value = requireObject(rawState, 'persistent Delivery V2 state');
  if (value.schemaVersion !== DELIVERY_V2_PERSISTENT_STATE_SCHEMA_VERSION) {
    throw new Error(`persistent state schemaVersion must be ${DELIVERY_V2_PERSISTENT_STATE_SCHEMA_VERSION}`);
  }

  const materialHeadSha = requireSha(value.materialHeadSha, 'materialHeadSha');
  const effectiveRisk = requireString(value.effectiveRisk, 'effectiveRisk').toLowerCase();
  const policy = executionPolicyFor(effectiveRisk);
  const attempts = normalizeAttempts(value.attempts);
  if (attempts.implementation > policy.maxImplementationAttempts) throw new Error('implementation attempt counter exceeds effective risk budget');
  if (attempts.audit > policy.maxAuditAttempts + 1) throw new Error('audit attempt counter exceeds effective risk budget');
  if (attempts.auditRemediation > policy.maxAuditAttempts) throw new Error('audit remediation counter exceeds effective risk budget');

  const workflowChecks = (value.workflowChecks ?? []).map(normalizeCheck);
  const blockingFindings = (value.blockingFindings ?? []).map(normalizeFinding);

  return Object.freeze({
    schemaVersion: DELIVERY_V2_PERSISTENT_STATE_SCHEMA_VERSION,
    revision: requirePositiveInteger(value.revision, 'revision', { allowZero: true }),
    repository: normalizeRepository(value.repository),
    issueNumber: value.issueNumber == null ? null : requirePositiveInteger(value.issueNumber, 'issueNumber'),
    pullRequestNumber: requirePositiveInteger(value.pullRequestNumber, 'pullRequestNumber'),
    baseRef: requireString(value.baseRef, 'baseRef'),
    baseSha: requireSha(value.baseSha, 'baseSha'),
    headRef: requireString(value.headRef, 'headRef'),
    materialHeadSha,
    effectiveRisk: policy.profile,
    classifier: normalizeClassifier(value.classifier, materialHeadSha),
    provider: requireString(value.provider, 'provider').toLowerCase(),
    status: normalizeStatus(value.status),
    attempts,
    workflowChecks: Object.freeze(workflowChecks),
    blockingFindings: Object.freeze(blockingFindings),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs),
    lastReason: value.lastReason == null ? null : requireString(value.lastReason, 'lastReason'),
    appliedTransitionIds: normalizeAppliedIds(value.appliedTransitionIds)
  });
}

export function createPersistentDeliveryState(input) {
  const value = requireObject(input, 'persistent state input');
  return normalizePersistentDeliveryState({
    schemaVersion: DELIVERY_V2_PERSISTENT_STATE_SCHEMA_VERSION,
    revision: value.revision ?? 0,
    repository: value.repository,
    issueNumber: value.issueNumber ?? null,
    pullRequestNumber: value.pullRequestNumber,
    baseRef: value.baseRef,
    baseSha: value.baseSha,
    headRef: value.headRef,
    materialHeadSha: value.materialHeadSha,
    effectiveRisk: value.effectiveRisk,
    classifier: value.classifier,
    provider: value.provider,
    status: value.status ?? 'queued',
    attempts: value.attempts ?? { implementation: 0, audit: 0, auditRemediation: 0 },
    workflowChecks: value.workflowChecks ?? [],
    blockingFindings: value.blockingFindings ?? [],
    evidenceRefs: value.evidenceRefs ?? [],
    lastReason: value.lastReason ?? null,
    appliedTransitionIds: value.appliedTransitionIds ?? []
  });
}

function normalizeObservedIdentity(observed) {
  const value = requireObject(observed, 'observed GitHub identity');
  return Object.freeze({
    repository: normalizeRepository(value.repository),
    pullRequestNumber: requirePositiveInteger(value.pullRequestNumber, 'observed.pullRequestNumber'),
    headRef: requireString(value.headRef, 'observed.headRef'),
    baseSha: requireSha(value.baseSha, 'observed.baseSha'),
    remoteHeadSha: requireSha(value.remoteHeadSha, 'observed.remoteHeadSha')
  });
}

function assertSameTarget(state, observed) {
  if (state.repository !== observed.repository) throw new Error('persisted state repository does not match observed GitHub repository');
  if (state.pullRequestNumber !== observed.pullRequestNumber) throw new Error('persisted state PR does not match observed GitHub PR');
  if (state.headRef !== observed.headRef) throw new Error('persisted state headRef does not match observed GitHub headRef');
}

function nextActionForStatus(status) {
  switch (status) {
    case 'queued': return 'classify';
    case 'classified': return 'implement';
    case 'implementing': return 'continue-implementation';
    case 'ci-pending': return 'observe-ci';
    case 'ci-failed-remediable': return 'remediate-ci';
    case 'audit-pending': return 'run-audit';
    case 'audit-failed-remediable': return 'remediate-audit';
    case 'ready-for-human-merge': return 'evaluate-release-gate';
    case 'escalated': return 'human-escalation';
    case 'terminal': return 'done';
    default: throw new Error(`unsupported Delivery V2 status: ${status}`);
  }
}

export function reconcilePersistentState(rawState, rawObserved) {
  const state = normalizePersistentDeliveryState(rawState);
  const observed = normalizeObservedIdentity(rawObserved);
  assertSameTarget(state, observed);

  const headDrift = observed.remoteHeadSha !== state.materialHeadSha;
  const baseDrift = observed.baseSha !== state.baseSha;
  if (!headDrift && !baseDrift) {
    return Object.freeze({
      state,
      staleStateDetected: false,
      nextAction: nextActionForStatus(state.status)
    });
  }

  const reconciled = normalizePersistentDeliveryState({
    ...state,
    revision: state.revision + 1,
    baseSha: observed.baseSha,
    materialHeadSha: observed.remoteHeadSha,
    status: 'queued',
    classifier: { ...state.classifier, subjectSha: observed.remoteHeadSha, current: false },
    workflowChecks: [],
    blockingFindings: [],
    evidenceRefs: [],
    lastReason: headDrift ? 'remote-head-drift' : 'remote-base-drift'
  });

  return Object.freeze({
    state: reconciled,
    staleStateDetected: true,
    nextAction: 'classify'
  });
}

function monotonicAttempts(previous, next) {
  for (const key of ['implementation', 'audit', 'auditRemediation']) {
    if (next[key] < previous[key]) throw new Error(`${key} attempt counter cannot decrease`);
  }
}

function assertEvidenceBoundToHead(checks, findings, materialHeadSha) {
  for (const check of checks) {
    if (check.subjectSha !== materialHeadSha) throw new Error(`workflow check ${check.name} is stale for material head`);
  }
  for (const finding of findings) {
    if (finding.candidateSha !== materialHeadSha) throw new Error(`blocking finding ${finding.id} is stale for material head`);
  }
}

export function applyPersistentCheckpoint(rawState, checkpoint) {
  const state = normalizePersistentDeliveryState(rawState);
  const value = requireObject(checkpoint, 'checkpoint');
  const transitionId = requireString(value.transitionId, 'checkpoint.transitionId');
  if (state.appliedTransitionIds.includes(transitionId)) return state;

  const observed = normalizeObservedIdentity(value.observed);
  assertSameTarget(state, observed);

  if (observed.remoteHeadSha !== state.materialHeadSha) {
    const reconciled = reconcilePersistentState(state, observed).state;
    return normalizePersistentDeliveryState({
      ...reconciled,
      revision: reconciled.revision + 1,
      appliedTransitionIds: [...reconciled.appliedTransitionIds, transitionId]
    });
  }

  const attempts = value.attempts == null ? state.attempts : normalizeAttempts(value.attempts);
  monotonicAttempts(state.attempts, attempts);
  const workflowChecks = value.workflowChecks == null ? state.workflowChecks : value.workflowChecks.map(normalizeCheck);
  const blockingFindings = value.blockingFindings == null ? state.blockingFindings : value.blockingFindings.map(normalizeFinding);
  assertEvidenceBoundToHead(workflowChecks, blockingFindings, state.materialHeadSha);

  const classifier = value.classifier == null ? state.classifier : normalizeClassifier(value.classifier, state.materialHeadSha);
  if (classifier.subjectSha !== state.materialHeadSha || !classifier.current) {
    throw new Error('checkpoint classifier must apply to the observed material head');
  }

  return normalizePersistentDeliveryState({
    ...state,
    revision: state.revision + 1,
    status: value.status == null ? state.status : normalizeStatus(value.status),
    effectiveRisk: value.effectiveRisk ?? state.effectiveRisk,
    classifier,
    provider: value.provider ?? state.provider,
    attempts,
    workflowChecks,
    blockingFindings,
    evidenceRefs: value.evidenceRefs == null ? state.evidenceRefs : normalizeEvidenceRefs(value.evidenceRefs),
    lastReason: value.lastReason === undefined ? state.lastReason : value.lastReason,
    appliedTransitionIds: [...state.appliedTransitionIds, transitionId]
  });
}

export async function savePersistentDeliveryState(filePath, rawState) {
  const state = normalizePersistentDeliveryState(rawState);
  const resolvedPath = requireString(filePath, 'state file path');
  await mkdir(dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, resolvedPath);
  return state;
}

export async function loadPersistentDeliveryState(filePath) {
  const resolvedPath = requireString(filePath, 'state file path');
  const raw = JSON.parse(await readFile(resolvedPath, 'utf8'));
  return normalizePersistentDeliveryState(raw);
}

export async function resumePersistentDelivery({ filePath, observed, persistReconciliation = true }) {
  const state = await loadPersistentDeliveryState(filePath);
  const result = reconcilePersistentState(state, observed);
  if (persistReconciliation && result.staleStateDetected) {
    await savePersistentDeliveryState(filePath, result.state);
  }
  return result;
}
