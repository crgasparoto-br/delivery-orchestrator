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
  finalCiRun,
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
  const ciQueue = ciQueueDurationMs(finalCiRun);
  const ciExecution = runDurationMs(finalCiRun);
  if (ciQueue == null || ciExecution == null) throw new Error('final CI timing is unavailable; refusing to fabricate zero duration');
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
      ciQueue,
      ciExecution,
      audit: observed.auditDurationMs,
      endToEnd: Math.max(0, nonNegativeInteger(nowMs, 'nowMs') - observed.startedAtMs)
    },
    terminalReason,
    change,
    escalated,
    evidenceRefs: [...observed.evidenceRefs, ...evidenceRefs]
  });
}