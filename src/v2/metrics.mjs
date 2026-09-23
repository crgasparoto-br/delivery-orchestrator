import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_METRICS_SCHEMA_VERSION = 1;

const SHA_RE = /^[0-9a-f]{40}$/i;
const COST_KEYS = new Set(['available', 'amount', 'currency']);
const USAGE_KEYS = new Set(['turns', 'credits', 'inputTokens', 'outputTokens', 'totalTokens']);
const HYGIENE_RESULTS = new Set(['PASS', 'PASS_WITH_DEBT', 'BLOCK', 'UNKNOWN']);
const RUN_LEDGER_KEYS = new Set([
  'runId', 'workflowRunId', 'phase', 'provider', 'model', 'worker',
  'usage', 'reportedCost', 'estimatedCost', 'observedAtIso', 'evidenceRef'
]);

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function requireInteger(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function requireNumber(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

function requirePositiveInteger(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
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

function normalizeCostAmount(value, label) {
  if (value == null) return null;
  const cost = requireObject(value, label);
  for (const key of Object.keys(cost)) {
    if (key !== 'amount' && key !== 'currency') throw new Error(`${label} contains unsupported field: ${key}`);
  }
  return Object.freeze({
    amount: requireNumber(cost.amount, `${label}.amount`),
    currency: requireString(cost.currency, `${label}.currency`).toUpperCase()
  });
}

function effectiveCostFrom(reportedCost, estimatedCost) {
  // Precedence invariant: reported cost is authoritative when present; estimated is a fallback.
  // reported and estimated are never summed together for the same entry.
  if (reportedCost) return Object.freeze({ amount: reportedCost.amount, currency: reportedCost.currency, source: 'reported' });
  if (estimatedCost) return Object.freeze({ amount: estimatedCost.amount, currency: estimatedCost.currency, source: 'estimated' });
  return null;
}

function normalizeProviderCost(value) {
  const empty = Object.freeze({
    available: false, amount: null, currency: null,
    reportedCost: null, estimatedCost: null, effectiveCost: null, accounting: 'unknown'
  });
  if (value == null) return empty;
  const cost = requireObject(value, 'providerCost');
  const hasStructured = Object.hasOwn(cost, 'reportedCost') || Object.hasOwn(cost, 'estimatedCost');
  const hasLegacy = !hasStructured && (Object.hasOwn(cost, 'amount') || Object.hasOwn(cost, 'currency'));
  const derivedOnlyKeys = new Set(['effectiveCost', 'accounting']);
  for (const key of Object.keys(cost)) {
    if (!COST_KEYS.has(key) && key !== 'reportedCost' && key !== 'estimatedCost' && !derivedOnlyKeys.has(key)) {
      throw new Error(`providerCost contains unsupported field: ${key}`);
    }
  }

  if (hasLegacy) {
    if (cost.available === false) {
      if (cost.amount != null || cost.currency != null) throw new Error('unavailable providerCost cannot contain amount or currency');
      return empty;
    }
    if (cost.available != null && cost.available !== true) throw new Error('providerCost.available must be boolean when present');
    const reportedCost = normalizeCostAmount({ amount: cost.amount, currency: cost.currency }, 'providerCost');
    const effectiveCost = effectiveCostFrom(reportedCost, null);
    return Object.freeze({
      available: true,
      amount: effectiveCost.amount,
      currency: effectiveCost.currency,
      reportedCost,
      estimatedCost: null,
      effectiveCost,
      accounting: 'complete'
    });
  }

  if (!hasStructured) return empty;

  const reportedCost = normalizeCostAmount(cost.reportedCost, 'providerCost.reportedCost');
  const estimatedCost = normalizeCostAmount(cost.estimatedCost, 'providerCost.estimatedCost');
  const effectiveCost = effectiveCostFrom(reportedCost, estimatedCost);
  return Object.freeze({
    available: effectiveCost != null,
    amount: effectiveCost?.amount ?? null,
    currency: effectiveCost?.currency ?? null,
    reportedCost,
    estimatedCost,
    effectiveCost,
    accounting: effectiveCost == null ? 'unknown' : (reportedCost ? 'complete' : 'partial')
  });
}

function normalizeTimestamp(value, label) {
  if (value == null) return null;
  const iso = requireString(value, label);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid ISO-8601 timestamp`);
  return new Date(ms).toISOString();
}

const RUN_LEDGER_DERIVED_KEYS = new Set(['effectiveCost', 'accounting']);

function normalizeProviderRunLedgerEntry(value, label) {
  const entry = requireObject(value, label);
  for (const key of Object.keys(entry)) {
    if (!RUN_LEDGER_KEYS.has(key) && !RUN_LEDGER_DERIVED_KEYS.has(key)) {
      throw new Error(`${label} contains unsupported field: ${key}`);
    }
  }
  const reportedCost = normalizeCostAmount(entry.reportedCost, `${label}.reportedCost`);
  const estimatedCost = normalizeCostAmount(entry.estimatedCost, `${label}.estimatedCost`);
  const effectiveCost = effectiveCostFrom(reportedCost, estimatedCost);
  const phase = requireString(entry.phase, `${label}.phase`).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(phase)) throw new Error(`invalid ${label}.phase: ${phase}`);
  return Object.freeze({
    runId: requirePositiveInteger(entry.runId, `${label}.runId`),
    workflowRunId: requirePositiveInteger(entry.workflowRunId, `${label}.workflowRunId`, { nullable: true }),
    phase,
    provider: requireString(entry.provider, `${label}.provider`).toLowerCase(),
    model: entry.model == null ? null : requireString(entry.model, `${label}.model`),
    worker: entry.worker == null ? null : requireString(entry.worker, `${label}.worker`),
    usage: normalizeAiUsage(entry.usage ?? {}, `${label}.usage`),
    reportedCost,
    estimatedCost,
    effectiveCost,
    accounting: effectiveCost == null ? 'unknown' : (reportedCost ? 'complete' : 'partial'),
    observedAtIso: normalizeTimestamp(entry.observedAtIso ?? null, `${label}.observedAtIso`),
    evidenceRef: entry.evidenceRef == null ? null : requireString(entry.evidenceRef, `${label}.evidenceRef`)
  });
}

function normalizeProviderRunLedger(value) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error('providerRunLedger must be an array');
  const normalized = value.map((item, index) => normalizeProviderRunLedgerEntry(item, `providerRunLedger[${index}]`));
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.runId)) throw new Error(`duplicate providerRunLedger runId: ${entry.runId}`);
    seen.add(entry.runId);
  }
  return Object.freeze(normalized);
}

function normalizeAiUsage(value = {}, label = 'aiUsage') {
  const usage = requireObject(value, label);
  for (const key of Object.keys(usage)) {
    if (!USAGE_KEYS.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
  const inputTokens = requireInteger(usage.inputTokens, `${label}.inputTokens`, { nullable: true });
  const outputTokens = requireInteger(usage.outputTokens, `${label}.outputTokens`, { nullable: true });
  const explicitTotal = requireInteger(usage.totalTokens, `${label}.totalTokens`, { nullable: true });
  const derivedTotal = inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null;
  if (explicitTotal != null && derivedTotal != null && explicitTotal !== derivedTotal) {
    throw new Error(`${label}.totalTokens must equal inputTokens + outputTokens when both are available`);
  }
  return Object.freeze({
    turns: requireInteger(usage.turns, `${label}.turns`, { nullable: true }),
    credits: requireNumber(usage.credits, `${label}.credits`, { nullable: true }),
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? derivedTotal
  });
}

function normalizeAiUsageByStage(value) {
  if (value == null) return Object.freeze({});
  const stages = requireObject(value, 'aiUsageByStage');
  const normalized = {};
  for (const [rawStage, usage] of Object.entries(stages)) {
    const stage = requireString(rawStage, 'aiUsageByStage stage').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(stage)) throw new Error(`invalid aiUsageByStage stage: ${rawStage}`);
    if (Object.hasOwn(normalized, stage)) throw new Error(`duplicate aiUsageByStage stage: ${stage}`);
    normalized[stage] = normalizeAiUsage(usage, `aiUsageByStage.${stage}`);
  }
  return Object.freeze(normalized);
}

function normalizeDurations(value) {
  const durations = requireObject(value, 'durationsMs');
  return Object.freeze({
    ciQueue: requireInteger(durations.ciQueue, 'durationsMs.ciQueue'),
    ciExecution: requireInteger(durations.ciExecution, 'durationsMs.ciExecution'),
    audit: requireInteger(durations.audit, 'durationsMs.audit'),
    endToEnd: requireInteger(durations.endToEnd, 'durationsMs.endToEnd')
  });
}

function normalizeChange(value) {
  const change = requireObject(value, 'change');
  const additions = requireInteger(change.additions, 'change.additions');
  const deletions = requireInteger(change.deletions, 'change.deletions');
  return Object.freeze({
    files: requireInteger(change.files, 'change.files'),
    additions,
    deletions,
    linesChanged: additions + deletions
  });
}

function normalizeEvidenceRefs(value = []) {
  if (!Array.isArray(value)) throw new Error('evidenceRefs must be an array');
  return Object.freeze([...new Set(value.map((item) => requireString(item, 'evidenceRefs entry')))]);
}

function normalizeTechnicalHygieneMetrics(value) {
  if (value == null) return null;
  const hygiene = requireObject(value, 'technicalHygiene');
  const result = requireString(hygiene.result, 'technicalHygiene.result').toUpperCase();
  if (!HYGIENE_RESULTS.has(result)) throw new Error(`unsupported technicalHygiene.result: ${result}`);
  return Object.freeze({
    result,
    promoted: hygiene.promoted === true,
    semanticCalls: requireInteger(hygiene.semanticCalls ?? 0, 'technicalHygiene.semanticCalls'),
    evidenceRef: requireString(hygiene.evidenceRef, 'technicalHygiene.evidenceRef')
  });
}

export function normalizeDeliveryMetrics(rawMetrics) {
  const value = requireObject(rawMetrics, 'Delivery V2 metrics');
  if (value.schemaVersion !== DELIVERY_V2_METRICS_SCHEMA_VERSION) {
    throw new Error(`metrics schemaVersion must be ${DELIVERY_V2_METRICS_SCHEMA_VERSION}`);
  }

  const repository = normalizeRepository(value.repository);
  const pullRequestNumber = requirePositiveInteger(value.pullRequestNumber, 'pullRequestNumber');
  const materialHeadSha = requireSha(value.materialHeadSha, 'materialHeadSha');
  const risk = requireString(value.risk, 'risk').toLowerCase();
  executionPolicyFor(risk);
  const provider = requireString(value.provider, 'provider').toLowerCase();
  const classifier = requireObject(value.classifier, 'classifier');
  const attempts = requireObject(value.attempts, 'attempts');

  return Object.freeze({
    schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION,
    deliveryId: `${repository}#${pullRequestNumber}@${materialHeadSha}`,
    repository,
    issueNumber: requirePositiveInteger(value.issueNumber, 'issueNumber', { nullable: true }),
    pullRequestNumber,
    materialHeadSha,
    risk,
    provider,
    classifier: Object.freeze({
      version: requireString(classifier.version, 'classifier.version'),
      fingerprint: requireString(classifier.fingerprint, 'classifier.fingerprint')
    }),
    providerCalls: requireInteger(value.providerCalls, 'providerCalls'),
    attempts: Object.freeze({
      implementation: requireInteger(attempts.implementation, 'attempts.implementation'),
      audit: requireInteger(attempts.audit, 'attempts.audit')
    }),
    aiUsage: normalizeAiUsage(value.aiUsage ?? {}),
    aiUsageByStage: normalizeAiUsageByStage(value.aiUsageByStage),
    technicalHygiene: normalizeTechnicalHygieneMetrics(value.technicalHygiene),
    providerCost: normalizeProviderCost(value.providerCost),
    providerRunLedger: normalizeProviderRunLedger(value.providerRunLedger),
    observedAtIso: normalizeTimestamp(value.observedAtIso ?? null, 'observedAtIso'),
    durationsMs: normalizeDurations(value.durationsMs),
    terminalReason: requireString(value.terminalReason, 'terminalReason'),
    change: normalizeChange(value.change),
    escalated: value.escalated === true,
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs)
  });
}

export function createDeliveryMetrics(input) {
  const value = requireObject(input, 'metrics input');
  return normalizeDeliveryMetrics({ schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION, ...value });
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeNullable(values, observations) {
  const known = values.filter((value) => value != null);
  return Object.freeze({
    known: known.length,
    unknown: observations - known.length,
    total: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
    avg: average(known),
    p50: percentile(known, 50),
    p95: percentile(known, 95)
  });
}

function summarizeAiUsage(usages) {
  return Object.freeze({
    turns: summarizeNullable(usages.map((usage) => usage.turns), usages.length),
    credits: summarizeNullable(usages.map((usage) => usage.credits), usages.length),
    inputTokens: summarizeNullable(usages.map((usage) => usage.inputTokens), usages.length),
    outputTokens: summarizeNullable(usages.map((usage) => usage.outputTokens), usages.length),
    totalTokens: summarizeNullable(usages.map((usage) => usage.totalTokens), usages.length)
  });
}

function summarizeHygiene(records) {
  const observations = records.map((record) => record.technicalHygiene).filter(Boolean);
  return Object.freeze({
    observations: observations.length,
    pass: observations.filter((item) => item.result === 'PASS').length,
    passWithDebt: observations.filter((item) => item.result === 'PASS_WITH_DEBT').length,
    block: observations.filter((item) => item.result === 'BLOCK').length,
    unknown: observations.filter((item) => item.result === 'UNKNOWN').length,
    promotions: observations.filter((item) => item.promoted).length,
    semanticCalls: observations.reduce((sum, item) => sum + item.semanticCalls, 0)
  });
}

function summarizeGroup(records) {
  const endToEnd = records.map((record) => record.durationsMs.endToEnd);
  const ciExecution = records.map((record) => record.durationsMs.ciExecution);
  const costByCurrency = {};
  const costAccountingByCurrency = {};
  let providerCostUnknownCount = 0;
  for (const record of records) {
    if (!record.providerCost.available) {
      providerCostUnknownCount += 1;
      continue;
    }
    const currency = record.providerCost.currency;
    costByCurrency[currency] = (costByCurrency[currency] ?? 0) + record.providerCost.amount;
    const isPartial = record.providerCost.accounting !== 'complete';
    costAccountingByCurrency[currency] = costAccountingByCurrency[currency] === 'partial' || isPartial ? 'partial' : 'complete';
  }
  return Object.freeze({
    deliveries: records.length,
    escalations: records.filter((record) => record.escalated).length,
    providerCalls: records.reduce((sum, record) => sum + record.providerCalls, 0),
    implementationAttempts: records.reduce((sum, record) => sum + record.attempts.implementation, 0),
    auditAttempts: records.reduce((sum, record) => sum + record.attempts.audit, 0),
    aiUsage: summarizeAiUsage(records.map((record) => record.aiUsage)),
    technicalHygiene: summarizeHygiene(records),
    endToEndMs: Object.freeze({ avg: average(endToEnd), p50: percentile(endToEnd, 50), p95: percentile(endToEnd, 95) }),
    ciExecutionMs: Object.freeze({ avg: average(ciExecution), p50: percentile(ciExecution, 50), p95: percentile(ciExecution, 95) }),
    providerCostTotals: Object.freeze(costByCurrency),
    providerCostAccounting: Object.freeze(costAccountingByCurrency),
    providerCostUnknownCount
  });
}

function summarizeStageGroups(records) {
  const groups = new Map();
  for (const record of records) {
    for (const [stage, usage] of Object.entries(record.aiUsageByStage)) {
      const key = `${record.repository}|${record.risk}|${record.provider}|${stage}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(usage);
    }
  }
  const result = {};
  for (const [key, usages] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    result[key] = Object.freeze({ observations: usages.length, aiUsage: summarizeAiUsage(usages) });
  }
  return Object.freeze(result);
}

export function summarizeDeliveryMetrics(rawRecords) {
  if (!Array.isArray(rawRecords)) throw new Error('metrics records must be an array');
  const records = rawRecords.map(normalizeDeliveryMetrics);
  const groups = new Map();
  for (const record of records) {
    const key = `${record.repository}|${record.risk}|${record.provider}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const byRepositoryRiskProvider = {};
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    byRepositoryRiskProvider[key] = summarizeGroup(group);
  }

  return Object.freeze({
    schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION,
    totalDeliveries: records.length,
    overall: summarizeGroup(records),
    byRepositoryRiskProvider: Object.freeze(byRepositoryRiskProvider),
    byRepositoryRiskProviderStage: summarizeStageGroups(records)
  });
}

export function compareAgainstBaseline(rawMetrics, baselineEndToEndMs) {
  const metrics = normalizeDeliveryMetrics(rawMetrics);
  const baseline = requireInteger(baselineEndToEndMs, 'baselineEndToEndMs');
  if (baseline === 0) throw new Error('baselineEndToEndMs must be greater than zero');
  const observed = metrics.durationsMs.endToEnd;
  return Object.freeze({
    deliveryId: metrics.deliveryId,
    baselineEndToEndMs: baseline,
    observedEndToEndMs: observed,
    reductionPercent: ((baseline - observed) / baseline) * 100,
    speedup: baseline / observed
  });
}

function normalizeStore(value) {
  const store = requireObject(value, 'metrics store');
  if (store.schemaVersion !== DELIVERY_V2_METRICS_SCHEMA_VERSION) throw new Error('metrics store schemaVersion must be 1');
  if (!Array.isArray(store.records)) throw new Error('metrics store records must be an array');
  const records = store.records.map(normalizeDeliveryMetrics);
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.deliveryId)) throw new Error(`duplicate metrics deliveryId: ${record.deliveryId}`);
    ids.add(record.deliveryId);
  }
  return Object.freeze({ schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION, records: Object.freeze(records) });
}

export async function loadDeliveryMetricsStore(filePath) {
  try {
    const raw = JSON.parse(await readFile(requireString(filePath, 'metrics file path'), 'utf8'));
    return normalizeStore(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION, records: Object.freeze([]) });
    throw error;
  }
}

export async function upsertDeliveryMetrics(filePath, rawMetrics) {
  const metrics = normalizeDeliveryMetrics(rawMetrics);
  const store = await loadDeliveryMetricsStore(filePath);
  const byId = new Map(store.records.map((record) => [record.deliveryId, record]));
  byId.set(metrics.deliveryId, metrics);
  const next = {
    schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION,
    records: [...byId.values()].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId))
  };
  const resolvedPath = requireString(filePath, 'metrics file path');
  await mkdir(dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, resolvedPath);
  return metrics;
}
