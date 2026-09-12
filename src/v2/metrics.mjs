import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_METRICS_SCHEMA_VERSION = 1;

const SHA_RE = /^[0-9a-f]{40}$/i;
const COST_KEYS = new Set(['available', 'amount', 'currency']);

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

function normalizeProviderCost(value) {
  if (value == null) return Object.freeze({ available: false, amount: null, currency: null });
  const cost = requireObject(value, 'providerCost');
  for (const key of Object.keys(cost)) {
    if (!COST_KEYS.has(key)) throw new Error(`providerCost contains unsupported field: ${key}`);
  }
  if (cost.available === false) {
    if (cost.amount != null || cost.currency != null) throw new Error('unavailable providerCost cannot contain amount or currency');
    return Object.freeze({ available: false, amount: null, currency: null });
  }
  if (cost.available != null && cost.available !== true) throw new Error('providerCost.available must be boolean when present');
  return Object.freeze({
    available: true,
    amount: requireNumber(cost.amount, 'providerCost.amount'),
    currency: requireString(cost.currency, 'providerCost.currency').toUpperCase()
  });
}

function normalizeAiUsage(value = {}) {
  const usage = requireObject(value, 'aiUsage');
  const inputTokens = requireInteger(usage.inputTokens, 'aiUsage.inputTokens', { nullable: true });
  const outputTokens = requireInteger(usage.outputTokens, 'aiUsage.outputTokens', { nullable: true });
  const explicitTotal = requireInteger(usage.totalTokens, 'aiUsage.totalTokens', { nullable: true });
  const derivedTotal = inputTokens == null && outputTokens == null ? null : (inputTokens ?? 0) + (outputTokens ?? 0);
  if (explicitTotal != null && derivedTotal != null && explicitTotal !== derivedTotal) {
    throw new Error('aiUsage.totalTokens must equal inputTokens + outputTokens when both are available');
  }
  return Object.freeze({
    turns: requireInteger(usage.turns, 'aiUsage.turns', { nullable: true }),
    credits: requireNumber(usage.credits, 'aiUsage.credits', { nullable: true }),
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? derivedTotal
  });
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
    providerCost: normalizeProviderCost(value.providerCost),
    durationsMs: normalizeDurations(value.durationsMs),
    terminalReason: requireString(value.terminalReason, 'terminalReason'),
    change: normalizeChange(value.change),
    escalated: value.escalated === true,
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs)
  });
}

export function createDeliveryMetrics(input) {
  const value = requireObject(input, 'metrics input');
  return normalizeDeliveryMetrics({
    schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION,
    ...value
  });
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

function summarizeGroup(records) {
  const endToEnd = records.map((record) => record.durationsMs.endToEnd);
  const ciExecution = records.map((record) => record.durationsMs.ciExecution);
  const costByCurrency = {};
  for (const record of records) {
    if (!record.providerCost.available) continue;
    costByCurrency[record.providerCost.currency] = (costByCurrency[record.providerCost.currency] ?? 0) + record.providerCost.amount;
  }
  return Object.freeze({
    deliveries: records.length,
    escalations: records.filter((record) => record.escalated).length,
    providerCalls: records.reduce((sum, record) => sum + record.providerCalls, 0),
    implementationAttempts: records.reduce((sum, record) => sum + record.attempts.implementation, 0),
    auditAttempts: records.reduce((sum, record) => sum + record.attempts.audit, 0),
    endToEndMs: Object.freeze({ avg: average(endToEnd), p50: percentile(endToEnd, 50), p95: percentile(endToEnd, 95) }),
    ciExecutionMs: Object.freeze({ avg: average(ciExecution), p50: percentile(ciExecution, 50), p95: percentile(ciExecution, 95) }),
    providerCostTotals: Object.freeze(costByCurrency)
  });
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
    byRepositoryRiskProvider: Object.freeze(byRepositoryRiskProvider)
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
