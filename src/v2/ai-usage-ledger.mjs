import { loadDeliveryMetricsStore } from './metrics.mjs';

export const AI_USAGE_LEDGER_SCHEMA_VERSION = 1;

/**
 * AI Usage & Cost Reporting ledger/projection.
 *
 * This module derives an evidence-preserving, per-provider-run projection from the
 * canonical Delivery V2 metrics store (`src/v2/metrics.mjs`, `schemas/delivery-v2-metrics.schema.json`).
 * It is deliberately a *projection*, not a second source of truth: every field it emits is
 * copied or deterministically recomputed from a `deliveryMetrics` record already produced by
 * the controller observability accumulator (`src/v2/controller-observability.mjs`).
 *
 * Identity and dedup reuse the same canonical keys the controller already uses:
 * - a provider run is identified by `providerRunLedger[].runId` (the same run identity the
 *   controller deduplicates on via `observedRunIds`);
 * - re-deriving the ledger from the same metrics store is idempotent because the store itself
 *   is keyed by `deliveryId` (`repository#pullRequestNumber@materialHeadSha`) and each record's
 *   `providerRunLedger` entries are unique by `runId` (enforced in `metrics.mjs`).
 *
 * Cost precedence: reported > estimated > unknown. `effectiveCost` is never a sum of reported
 * and estimated cost for the same entry; it is the higher-precedence value, tagged with its
 * `source`. Currencies are never summed together; aggregation always groups by currency.
 */

function requireString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

/**
 * Flattens delivery metrics records into per-provider-run ledger entries.
 *
 * Records that already carry a `providerRunLedger` (the forward-looking, run-granular shape)
 * contribute one entry per provider run, with workflow run, provider, model, worker, phase and
 * cost precedence preserved exactly as recorded.
 *
 * Legacy records (pre-existing metrics without `providerRunLedger`) fall back to aggregate rows
 * derived from `aiUsageByStage`/`providerCost` without fabricating run identity, model or worker
 * attribution that was never captured; those rows are marked `runGranularity: 'aggregate'` so
 * reporting can distinguish known run-level provenance from legacy delivery-level provenance.
 */
export function deriveLedgerEntries(records) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const entries = [];
  for (const record of records) {
    const base = {
      deliveryId: record.deliveryId,
      repository: record.repository,
      issueNumber: record.issueNumber,
      pullRequestNumber: record.pullRequestNumber,
      risk: record.risk
    };

    if (record.providerRunLedger.length > 0) {
      for (const run of record.providerRunLedger) {
        entries.push({
          ...base,
          runId: run.runId,
          workflowRunId: run.workflowRunId,
          phase: run.phase,
          provider: run.provider,
          model: run.model,
          worker: run.worker,
          usage: run.usage,
          reportedCost: run.reportedCost,
          estimatedCost: run.estimatedCost,
          effectiveCost: run.effectiveCost,
          accounting: run.accounting,
          observedAtIso: run.observedAtIso ?? record.observedAtIso,
          evidenceRef: run.evidenceRef,
          runGranularity: 'run'
        });
      }
      continue;
    }

    const stages = Object.keys(record.aiUsageByStage);
    for (const stage of stages) {
      entries.push({
        ...base,
        runId: null,
        workflowRunId: null,
        phase: stage,
        provider: record.provider,
        model: null,
        worker: null,
        usage: record.aiUsageByStage[stage],
        reportedCost: null,
        estimatedCost: null,
        effectiveCost: null,
        accounting: 'unknown',
        observedAtIso: record.observedAtIso,
        evidenceRef: null,
        runGranularity: 'aggregate'
      });
    }

    // Legacy delivery-level cost is not attributable to a single phase/run; emit it once,
    // separately from stage usage rows, so cost is never duplicated across stages.
    if (record.providerCost.available) {
      entries.push({
        ...base,
        runId: null,
        workflowRunId: null,
        phase: null,
        provider: record.provider,
        model: null,
        worker: null,
        usage: null,
        reportedCost: record.providerCost.reportedCost,
        estimatedCost: record.providerCost.estimatedCost,
        effectiveCost: record.providerCost.effectiveCost,
        accounting: record.providerCost.accounting,
        observedAtIso: record.observedAtIso,
        evidenceRef: null,
        runGranularity: 'aggregate'
      });
    } else if (stages.length === 0) {
      // A delivery with zero known usage and zero known cost still counts as an observed,
      // fully-accounted-for (zero-provider-call) delivery; represent it explicitly rather than
      // silently dropping it from totals.
      entries.push({
        ...base,
        runId: null,
        workflowRunId: null,
        phase: null,
        provider: record.provider,
        model: null,
        worker: null,
        usage: null,
        reportedCost: null,
        estimatedCost: null,
        effectiveCost: null,
        accounting: 'unknown',
        observedAtIso: record.observedAtIso,
        evidenceRef: null,
        runGranularity: 'aggregate'
      });
    }
  }
  return entries;
}

export function filterLedgerEntries(entries, {
  from = null,
  to = null,
  repository = null,
  issueNumber = null,
  pullRequestNumber = null,
  phase = null
} = {}) {
  return entries.filter((entry) => {
    if (repository && entry.repository !== repository) return false;
    if (issueNumber != null && entry.issueNumber !== issueNumber) return false;
    if (pullRequestNumber != null && entry.pullRequestNumber !== pullRequestNumber) return false;
    if (phase && entry.phase !== phase) return false;
    if ((from || to) && !entry.observedAtIso) return false;
    if (from && entry.observedAtIso < from) return false;
    if (to && entry.observedAtIso > to) return false;
    return true;
  });
}

const TOKEN_FIELDS = Object.freeze(['turns', 'credits', 'inputTokens', 'outputTokens', 'totalTokens']);

function summarizeUsage(entries) {
  const known = { turns: 0, credits: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const knownCount = { turns: 0, credits: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const entry of entries) {
    if (!entry.usage) continue;
    for (const field of TOKEN_FIELDS) {
      const value = entry.usage[field];
      if (value != null) {
        known[field] += value;
        knownCount[field] += 1;
      }
    }
  }
  const usageObservations = entries.filter((entry) => entry.usage != null).length;
  const result = {};
  for (const field of TOKEN_FIELDS) {
    result[field] = Object.freeze({
      known: knownCount[field],
      unknown: usageObservations - knownCount[field],
      total: knownCount[field] > 0 ? known[field] : null
    });
  }
  return Object.freeze(result);
}

/**
 * Aggregates ledger entries into per-currency cost totals plus usage totals.
 *
 * Currencies are never mixed: `costByCurrency` always groups by currency. Within a currency,
 * `reportedCost`/`estimatedCost` are kept as separate running totals for transparency, while
 * `effectiveCost` is the sum of each entry's own precedence-resolved effective cost (never the
 * sum of reported+estimated for the same entry). `accounting` is `complete` only when every
 * contributing entry/currency resolved to a reported cost; the presence of any estimated or
 * unknown-cost entry makes the aggregate `partial`.
 */
export function aggregateLedgerEntries(entries) {
  const byCurrency = new Map();
  let unknownCostEntries = 0;

  for (const entry of entries) {
    if (!entry.effectiveCost) {
      unknownCostEntries += 1;
      continue;
    }
    const currency = entry.effectiveCost.currency;
    if (!byCurrency.has(currency)) {
      byCurrency.set(currency, { reported: 0, estimated: 0, effective: 0, partial: false });
    }
    const bucket = byCurrency.get(currency);
    bucket.effective += entry.effectiveCost.amount;
    if (entry.effectiveCost.source === 'reported') {
      bucket.reported += entry.effectiveCost.amount;
    } else {
      bucket.estimated += entry.effectiveCost.amount;
      bucket.partial = true;
    }
  }

  const costByCurrency = {};
  for (const [currency, bucket] of [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    costByCurrency[currency] = Object.freeze({
      reportedCost: bucket.reported,
      estimatedCost: bucket.estimated,
      effectiveCost: bucket.effective,
      accounting: bucket.partial ? 'partial' : 'complete'
    });
  }

  const anyCurrencyPartial = [...byCurrency.values()].some((bucket) => bucket.partial);
  const accounting = entries.length === 0
    ? 'unknown'
    : (unknownCostEntries > 0 || anyCurrencyPartial ? 'partial' : 'complete');

  return Object.freeze({
    entriesCount: entries.length,
    unknownCostEntries,
    costByCurrency: Object.freeze(costByCurrency),
    accounting,
    usage: summarizeUsage(entries)
  });
}

export function groupLedgerEntries(entries, groupBy = ['repository', 'phase']) {
  if (!Array.isArray(groupBy) || groupBy.length === 0) throw new Error('groupBy must be a non-empty array');
  const groups = new Map();
  for (const entry of entries) {
    const key = groupBy.map((field) => String(entry[field] ?? 'unknown')).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const result = {};
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    result[key] = aggregateLedgerEntries(group);
  }
  return Object.freeze(result);
}

/**
 * Resolves a deterministic UTC period window from CLI-style filters.
 * `--today`/`--month` are computed at UTC; other timezones are rejected rather than silently
 * reinterpreted, to keep report boundaries reproducible across CI/local runs.
 */
export function resolvePeriod({ today = false, month = null, from = null, to = null, timezone = 'UTC', nowMs = Date.now() } = {}) {
  const resolvedTimezone = requireString(timezone, 'timezone').toUpperCase();
  if (resolvedTimezone !== 'UTC') {
    throw new Error('only the UTC timezone is currently supported for deterministic AI usage report period boundaries');
  }
  if (today) {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    return Object.freeze({ from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z`, timezone: 'UTC' });
  }
  if (month) {
    const now = new Date(nowMs);
    const isExplicit = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month);
    const [year, monthNumber] = isExplicit
      ? month.split('-').map(Number)
      : [now.getUTCFullYear(), now.getUTCMonth() + 1];
    const start = new Date(Date.UTC(year, monthNumber - 1, 1));
    const end = new Date(Date.UTC(year, monthNumber, 1) - 1);
    return Object.freeze({ from: start.toISOString(), to: end.toISOString(), timezone: 'UTC' });
  }
  return Object.freeze({ from, to, timezone: 'UTC' });
}

/**
 * Builds the full AI Usage & Cost report from the canonical metrics store. This is the single
 * aggregation function every consumer (CLI, JSON export, CSV/HTML export, GitHub Job Summary)
 * must call, so totals never diverge between output formats.
 */
export async function buildAiUsageReport({
  metricsFile,
  today = false,
  month = null,
  from = null,
  to = null,
  timezone = 'UTC',
  repository = null,
  issueNumber = null,
  pullRequestNumber = null,
  phase = null,
  groupBy = ['repository', 'phase'],
  nowMs = Date.now()
} = {}) {
  const store = await loadDeliveryMetricsStore(metricsFile);
  const entries = deriveLedgerEntries(store.records);
  const period = resolvePeriod({ today, month, from, to, timezone, nowMs });
  const filtered = filterLedgerEntries(entries, {
    from: period.from,
    to: period.to,
    repository,
    issueNumber,
    pullRequestNumber,
    phase
  });

  return Object.freeze({
    schemaVersion: AI_USAGE_LEDGER_SCHEMA_VERSION,
    generatedAtIso: new Date(nowMs).toISOString(),
    period,
    filters: Object.freeze({ repository, issueNumber, pullRequestNumber, phase }),
    totalDeliveries: store.records.length,
    totals: aggregateLedgerEntries(filtered),
    groups: groupLedgerEntries(filtered, groupBy)
  });
}
