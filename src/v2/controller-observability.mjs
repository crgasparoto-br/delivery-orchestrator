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

export function createControllerObservability({ startedAtMs = Date.now() } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    startedAtMs: nonNegativeInteger(startedAtMs, 'startedAtMs'),
    providerCalls: 0,
    providerRunIds: Object.freeze([]),
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
  const runIds = value.providerRunIds ?? [];
  if (!Array.isArray(runIds)) throw new Error('observability.providerRunIds must be an array');
  const normalizedRunIds = runIds.map((item) => positiveInteger(item, 'observability provider run id'));
  if (new Set(normalizedRunIds).size !== normalizedRunIds.length) throw new Error('observability.providerRunIds must be unique');
  const providerCalls = nonNegativeInteger(value.providerCalls, 'observability.providerCalls');
  if (providerCalls !== normalizedRunIds.length) throw new Error('observability.providerCalls must equal providerRunIds length');
  const stages = requiredObject(value.aiUsageByStage, 'observability.aiUsageByStage');
  return Object.freeze({
    schemaVersion: 1,
    startedAtMs: nonNegativeInteger(value.startedAtMs, 'observability.startedAtMs'),
    providerCalls,
    providerRunIds: Object.freeze(normalizedRunIds),
    aiUsageByStage: Object.freeze({
      implementation: normalizeGhAwUsage(stages.implementation ?? {}),
      audit: normalizeGhAwUsage(stages.audit ?? {})
    }),
    auditDurationMs: nonNegativeInteger(value.auditDurationMs, 'observability.auditDurationMs'),
    evidenceRefs: normalizeRefs(value.evidenceRefs)
  });
}

export function recordControllerProviderObservation(raw, { runId, stage, usage = {}, durationMs = 0, evidenceRef = null } = {}) {
  const current = normalizeControllerObservability(raw);
  if (usage && typeof usage === 'object' && !Array.isArray(usage) && usage.providerCalls === 0) return current;
  const resolvedRunId = positiveInteger(runId, 'runId');
  const resolvedStage = requiredString(stage, 'stage').toLowerCase();
  if (!STAGES.has(resolvedStage)) throw new Error(`unsupported provider stage: ${resolvedStage}`);
  if (current.providerRunIds.includes(resolvedRunId)) return current;
  const normalizedUsage = normalizeGhAwUsage(usage);
  const nextUsage = mergeGhAwUsage([current.aiUsageByStage[resolvedStage], normalizedUsage]);
  const refs = evidenceRef ? [...current.evidenceRefs, requiredString(evidenceRef, 'evidenceRef')] : [...current.evidenceRefs];
  return Object.freeze({
    ...current,
    providerCalls: current.providerCalls + 1,
    providerRunIds: Object.freeze([...current.providerRunIds, resolvedRunId]),
    aiUsageByStage: Object.freeze({
      ...current.aiUsageByStage,
      [resolvedStage]: nextUsage
    }),
    auditDurationMs: current.auditDurationMs + (resolvedStage === 'audit' ? nonNegativeInteger(durationMs, 'durationMs') : 0),
    evidenceRefs: normalizeRefs(refs)
  });
}

export function runDurationMs(run) {
  if (!run) return 0;
  const started = Date.parse(run.run_started_at ?? run.created_at ?? run.updated_at);
  const ended = Date.parse(run.updated_at ?? run.run_started_at ?? run.created_at);
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
}

export function ciQueueDurationMs(run) {
  if (!run) return 0;
  const created = Date.parse(run.created_at);
  const started = Date.parse(run.run_started_at ?? run.created_at);
  return Number.isFinite(created) && Number.isFinite(started) ? Math.max(0, started - created) : 0;
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
      ciQueue: ciQueueDurationMs(finalCiRun),
      ciExecution: runDurationMs(finalCiRun),
      audit: observed.auditDurationMs,
      endToEnd: Math.max(0, nonNegativeInteger(nowMs, 'nowMs') - observed.startedAtMs)
    },
    terminalReason,
    change,
    escalated,
    evidenceRefs: [...observed.evidenceRefs, ...evidenceRefs]
  });
}
