import { createDeliveryMetrics } from './metrics.mjs';
import { mergeGhAwUsage, normalizeGhAwUsage } from './usage-telemetry.mjs';

const STAGES = new Set(['implementation', 'audit']);

function requiredObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function normalizeRefs(value = []) {
  if (!Array.isArray(value)) throw new Error('observability.evidenceRefs must be an array');
  return Object.freeze([...new Set(value.map((item) => requiredString(item, 'observability evidence ref')))]);
}

function normalizeRunIds(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map((item) => positiveInteger(item, `${label} entry`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique`);
  return normalized;
}

export function createControllerObservability({ startedAtMs = Date.now() } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    startedAtMs: nonNegativeInteger(startedAtMs, 'startedAtMs'),
    providerCalls: 0,
    providerRunIds: Object.freeze([]),
    observedRunIds: Object.freeze([]),
    aiUsageByStage: Object.freeze({
      implementation: normalizeGhAwUsage({}),
      audit: normalizeGhAwUsage({})
    }),
    ciTimingHistoryComplete: true,
    ciRunIds: Object.freeze([]),
    ciQueueDurationMs: 0,
    ciExecutionDurationMs: 0,
    auditDurationMs: 0,
    evidenceRefs: Object.freeze([])
  });
}

export function normalizeControllerObservability(raw) {
  const value = requiredObject(raw, 'controller observability');
  if (value.schemaVersion !== 1) throw new Error('controller observability schemaVersion must be 1');
  const normalizedRunIds = normalizeRunIds(value.providerRunIds ?? [], 'observability.providerRunIds');
  const observedRunIds = normalizeRunIds(value.observedRunIds ?? normalizedRunIds, 'observability.observedRunIds');
  for (const runId of normalizedRunIds) {
    if (!observedRunIds.includes(runId)) throw new Error('observability.observedRunIds must include every provider run id');
  }
  const providerCalls = nonNegativeInteger(value.providerCalls, 'observability.providerCalls');
  if (providerCalls !== normalizedRunIds.length) throw new Error('observability.providerCalls must equal providerRunIds length');
  const stages = requiredObject(value.aiUsageByStage, 'observability.aiUsageByStage');

  const hasAnyCiTimingField = [
    'ciTimingHistoryComplete',
    'ciRunIds',
    'ciQueueDurationMs',
    'ciExecutionDurationMs'
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));

  const hasCompleteCiTimingFields =
    Array.isArray(value.ciRunIds) &&
    Number.isInteger(value.ciQueueDurationMs) &&
    value.ciQueueDurationMs >= 0 &&
    Number.isInteger(value.ciExecutionDurationMs) &&
    value.ciExecutionDurationMs >= 0;

  if (value.ciTimingHistoryComplete != null &&
      typeof value.ciTimingHistoryComplete !== 'boolean') {
    throw new Error('observability.ciTimingHistoryComplete must be boolean when present');
  }

  if (hasAnyCiTimingField && !hasCompleteCiTimingFields) {
    throw new Error('controller observability CI timing fields must be complete when present');
  }

  const ciTimingHistoryComplete =
    value.ciTimingHistoryComplete == null
      ? hasCompleteCiTimingFields
      : value.ciTimingHistoryComplete;

  if (ciTimingHistoryComplete && !hasCompleteCiTimingFields) {
    throw new Error('complete CI timing history requires persisted CI timing fields');
  }

  const ciRunIds = hasCompleteCiTimingFields
    ? normalizeRunIds(value.ciRunIds, 'observability.ciRunIds')
    : [];

  return Object.freeze({
    schemaVersion: 1,
    startedAtMs: nonNegativeInteger(value.startedAtMs, 'observability.startedAtMs'),
    providerCalls,
    providerRunIds: Object.freeze(normalizedRunIds),
    observedRunIds: Object.freeze(observedRunIds),
    aiUsageByStage: Object.freeze({
      implementation: normalizeGhAwUsage(stages.implementation ?? {}),
      audit: normalizeGhAwUsage(stages.audit ?? {})
    }),
    ciTimingHistoryComplete,
    ciRunIds: Object.freeze(ciRunIds),
    ciQueueDurationMs: hasCompleteCiTimingFields
      ? nonNegativeInteger(value.ciQueueDurationMs, 'observability.ciQueueDurationMs')
      : 0,
    ciExecutionDurationMs: hasCompleteCiTimingFields
      ? nonNegativeInteger(value.ciExecutionDurationMs, 'observability.ciExecutionDurationMs')
      : 0,
    auditDurationMs: nonNegativeInteger(value.auditDurationMs, 'observability.auditDurationMs'),
    evidenceRefs: normalizeRefs(value.evidenceRefs)
  });
}

export function recordControllerProviderObservation(raw, { runId, stage, usage = {}, durationMs = null, evidenceRef = null } = {}) {
  const current = normalizeControllerObservability(raw);
  const resolvedRunId = positiveInteger(runId, 'runId');
  const resolvedStage = requiredString(stage, 'stage').toLowerCase();
  if (!STAGES.has(resolvedStage)) throw new Error(`unsupported provider stage: ${resolvedStage}`);
  if (current.observedRunIds.includes(resolvedRunId)) return current;

  const zeroProviderCalls = usage && typeof usage === 'object' && !Array.isArray(usage) && usage.providerCalls === 0;
  const refs = evidenceRef ? [...current.evidenceRefs, requiredString(evidenceRef, 'evidenceRef')] : [...current.evidenceRefs];
  const auditDurationMs = current.auditDurationMs + (resolvedStage === 'audit' ? nonNegativeInteger(durationMs, 'durationMs') : 0);
  const observedRunIds = Object.freeze([...current.observedRunIds, resolvedRunId]);

  if (zeroProviderCalls) {
    return Object.freeze({
      ...current,
      observedRunIds,
      auditDurationMs,
      evidenceRefs: normalizeRefs(refs)
    });
  }

  const normalizedUsage = normalizeGhAwUsage(usage);
  const nextUsage = mergeGhAwUsage([current.aiUsageByStage[resolvedStage], normalizedUsage]);
  return Object.freeze({
    ...current,
    providerCalls: current.providerCalls + 1,
    providerRunIds: Object.freeze([...current.providerRunIds, resolvedRunId]),
    observedRunIds,
    aiUsageByStage: Object.freeze({
      ...current.aiUsageByStage,
      [resolvedStage]: nextUsage
    }),
    auditDurationMs,
    evidenceRefs: normalizeRefs(refs)
  });
}

export function recordControllerCiObservation(raw, { run, evidenceRef = null } = {}) {
  const current = normalizeControllerObservability(raw);
  const workflowRun = requiredObject(run, 'CI workflow run');
  const runId = positiveInteger(workflowRun.id, 'CI workflow run id');

  if (current.ciRunIds.includes(runId)) return current;

  const queueDuration = ciQueueDurationMs(workflowRun);
  const executionDuration = runDurationMs(workflowRun);

  if (queueDuration == null || executionDuration == null) {
    throw new Error(`CI timing is unavailable for workflow run ${runId}; refusing to fabricate duration`);
  }

  const refs = evidenceRef
    ? [...current.evidenceRefs, requiredString(evidenceRef, 'evidenceRef')]
    : [...current.evidenceRefs];

  return Object.freeze({
    ...current,
    ciRunIds: Object.freeze([...current.ciRunIds, runId]),
    ciQueueDurationMs: current.ciQueueDurationMs + queueDuration,
    ciExecutionDurationMs: current.ciExecutionDurationMs + executionDuration,
    evidenceRefs: normalizeRefs(refs)
  });
}

export function runDurationMs(run) {
  if (!run) return null;
  const started = Date.parse(run.run_started_at);
  const ended = Date.parse(run.updated_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return ended - started;
}

export function ciQueueDurationMs(run) {
  if (!run) return null;
  const created = Date.parse(run.created_at);
  const started = Date.parse(run.run_started_at);
  if (!Number.isFinite(created) || !Number.isFinite(started) || started < created) return null;
  return started - created;
}

export function createControllerDeliveryMetrics({
  observability,
  repository,
  issueNumber,
  pullRequestNumber,
  materialHeadSha,
  risk,
  provider,
  classifier,
  attempts,
  change,
  terminalReason,
  escalated = false,
  evidenceRefs = [],
  nowMs = Date.now()
} = {}) {
  const observed = normalizeControllerObservability(observability);
  const aiUsage = mergeGhAwUsage([
    observed.aiUsageByStage.implementation,
    observed.aiUsageByStage.audit
  ]);
  if (!observed.ciTimingHistoryComplete) {
    throw new Error('CI timing history is incomplete; refusing to publish complete delivery metrics');
  }
  if (observed.ciRunIds.length === 0) {
    throw new Error('CI timing history has no observed workflow run');
  }
  return createDeliveryMetrics({
    repository,
    issueNumber,
    pullRequestNumber,
    materialHeadSha,
    risk,
    provider,
    classifier,
    providerCalls: observed.providerCalls,
    attempts,
    aiUsage,
    aiUsageByStage: observed.aiUsageByStage,
    providerCost: { available: false, amount: null, currency: null },
    durationsMs: {
      ciQueue: observed.ciQueueDurationMs,
      ciExecution: observed.ciExecutionDurationMs,
      audit: observed.auditDurationMs,
      endToEnd: Math.max(0, nonNegativeInteger(nowMs, 'nowMs') - observed.startedAtMs)
    },
    terminalReason,
    change,
    escalated,
    evidenceRefs: [...observed.evidenceRefs, ...evidenceRefs]
  });
}