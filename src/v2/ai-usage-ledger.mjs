import { loadOperationalMetricsStore } from './metrics-store.mjs';

export const AI_USAGE_LEDGER_SCHEMA_VERSION = 1;

/**
 * AI Usage & Cost Reporting ledger/projection.
 *
 * This module derives an evidence-preserving, per-provider-run projection from the single
 * operational Delivery V2 metrics store (`src/v2/metrics-store.mjs`, written by the controllers
 * through the canonical `src/v2/metrics.mjs` contract). It is a *projection*, not a second
 * source of truth: every field it emits is copied or deterministically recomputed from a metrics
 * record that the controller observability accumulator already produced.
 *
 * Identity and dedup reuse the canonical provider-run identity the controller deduplicates on
 * (`providerRunLedger[].runId`, mirroring `observedRunIds`). Re-deriving from the same store is
 * idempotent because the store is keyed by `deliveryId` and each record's ledger is unique by
 * `runId`.
 *
 * Cost precedence: reported > estimated > unknown. `effectiveCost` is never a sum of reported and
 * estimated for the same run. Currencies are never summed together and never converted.
 */

function requireString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

/** Parses an ISO-8601 instant into epoch milliseconds. Offsets like `Z` and `+00:00` are equivalent. */
export function toInstantMs(value, label) {
  if (value == null) return null;
  const text = requireString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid ISO-8601 instant: ${text}`);
  return ms;
}

/**
 * Entry kinds, which reporting must keep distinct:
 * - `run`: a real provider run with run-granular evidence. Its cost may still be unknown.
 * - `zero-calls`: a delivery *proven* to have made no provider call. It contributes calls=0 and
 *   is never counted as a provider run of unknown cost, and never gets fabricated tokens/cost.
 * - `legacy-aggregate`: a pre-ledger historical record, where only delivery-level aggregates
 *   exist. Its incompleteness is reported separately from a genuinely unknown run cost.
 */
export const LEDGER_ENTRY_KINDS = Object.freeze(['run', 'zero-calls', 'legacy-aggregate']);

/** True when a ledger entry is evidence of audit work, i.e. it belongs to the `audit` phase. */
export function isAuditEvidenceEntry(entry) {
  return entry.phase === 'audit';
}

export function deriveLedgerEntries(records) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const entries = [];
  for (const record of records) {
    const base = {
      deliveryId: record.deliveryId,
      repository: record.repository,
      issueNumber: record.issueNumber,
      pullRequestNumber: record.pullRequestNumber,
      risk: record.risk,
      escalated: record.escalated,
      // Delivery-level counters. They describe the DELIVERY, never the subset of entries a
      // grouped report happens to contain, so aggregation may only use them when the scope
      // provably covers that delivery's whole evidence for the counter (see
      // `aggregateLedgerEntries`). They are deliberately named `delivery*` so a group-scoped
      // total can never be read off an entry by accident.
      deliveryAuditAttempts: record.attempts.audit,
      deliveryImplementationAttempts: record.attempts.implementation,
      deliveryObservedAtIso: record.observedAtIso
    };
    const runAccounting = record.providerRunAccounting ?? 'legacy';
    const recordStart = entries.length;

    if (record.providerRunLedger.length > 0) {
      for (const run of record.providerRunLedger) {
        entries.push({
          ...base,
          kind: 'run',
          runId: run.runId,
          workflowRunId: run.workflowRunId,
          materialHeadSha: run.materialHeadSha ?? record.materialHeadSha,
          phase: run.phase,
          provider: run.provider,
          model: run.model,
          worker: run.worker,
          role: run.role,
          implementationAttempt: run.implementationAttempt,
          remediationAttempt: run.remediationAttempt,
          auditAttempt: run.auditAttempt ?? null,
          usage: run.usage,
          usageAccounting: run.usageAccounting,
          cache: run.cache,
          reportedCost: run.reportedCost,
          estimatedCost: run.estimatedCost,
          effectiveCost: run.effectiveCost,
          costProvenance: run.costProvenance,
          pricingSnapshot: run.pricingSnapshot,
          accounting: run.accounting,
          startedAtIso: run.startedAtIso,
          // The terminal instant of a provider run is the run's OWN observed end. It is never
          // back-filled from the delivery-level timestamp: an unknown end stays unknown.
          endedAtIso: run.endedAtIso,
          observedAtIso: run.observedAtIso,
          terminalState: run.terminalState,
          evidenceRef: run.evidenceRef,
          runGranularity: 'run'
        });
      }
      stampAuditEvidenceCensus(entries, recordStart);
      continue;
    }

    if (runAccounting === 'complete' && record.providerCalls === 0) {
      // Proven zero provider calls: calls=0, no tokens, no cost, and explicitly NOT an
      // unknown-cost provider run.
      entries.push({
        ...base,
        kind: 'zero-calls',
        runId: null,
        workflowRunId: null,
        materialHeadSha: record.materialHeadSha,
        phase: null,
        provider: record.provider,
        model: null,
        worker: null,
        role: null,
        implementationAttempt: null,
        remediationAttempt: null,
        auditAttempt: null,
        usage: null,
        usageAccounting: 'zero-calls',
        cache: null,
        reportedCost: null,
        estimatedCost: null,
        effectiveCost: null,
        costProvenance: 'zero-calls',
        pricingSnapshot: null,
        accounting: 'complete',
        startedAtIso: null,
        endedAtIso: record.observedAtIso,
        observedAtIso: record.observedAtIso,
        terminalState: record.terminalReason,
        evidenceRef: null,
        runGranularity: 'delivery'
      });
      stampAuditEvidenceCensus(entries, recordStart);
      continue;
    }

    const legacyBase = {
      ...base,
      kind: 'legacy-aggregate',
      runId: null,
      workflowRunId: null,
      materialHeadSha: record.materialHeadSha,
      model: null,
      worker: null,
      role: null,
      implementationAttempt: null,
      remediationAttempt: null,
      auditAttempt: null,
      cache: null,
      pricingSnapshot: null,
      startedAtIso: null,
      endedAtIso: record.observedAtIso,
      observedAtIso: record.observedAtIso,
      terminalState: record.terminalReason,
      evidenceRef: null,
      runGranularity: 'aggregate'
    };

    const stages = Object.keys(record.aiUsageByStage);
    for (const stage of stages) {
      entries.push({
        ...legacyBase,
        phase: stage,
        provider: record.provider,
        usage: record.aiUsageByStage[stage],
        usageAccounting: 'partial',
        reportedCost: null,
        estimatedCost: null,
        effectiveCost: null,
        costProvenance: 'unknown',
        accounting: 'unknown'
      });
    }

    // Legacy delivery-level cost is not attributable to a single phase/run; emit it once,
    // separately from stage usage rows, so cost is never duplicated across stages.
    if (record.providerCost.available) {
      entries.push({
        ...legacyBase,
        phase: null,
        provider: record.provider,
        usage: null,
        usageAccounting: 'unknown',
        reportedCost: record.providerCost.reportedCost,
        estimatedCost: record.providerCost.estimatedCost,
        effectiveCost: record.providerCost.effectiveCost,
        costProvenance: record.providerCost.reportedCost ? 'reported' : 'estimated',
        accounting: record.providerCost.accounting
      });
    } else if (stages.length === 0) {
      entries.push({
        ...legacyBase,
        phase: null,
        provider: record.provider,
        usage: null,
        usageAccounting: 'unknown',
        reportedCost: null,
        estimatedCost: null,
        effectiveCost: null,
        costProvenance: 'unknown',
        accounting: 'unknown'
      });
    }
    stampAuditEvidenceCensus(entries, recordStart);
  }
  return entries;
}

/**
 * Stamps on every entry of one delivery how many of that delivery's entries are audit evidence,
 * and whether every one of them carries a run-granular audit attempt identity.
 *
 * This is what lets a grouped report tell "this group holds all of the delivery's audit work"
 * apart from "this group holds only part of it (or none)". Only in the first case may the
 * delivery-level `attempts.audit` be attributed to the group; otherwise the group reports
 * `unknown`/`partial` instead of inheriting a delivery total it does not cover.
 */
function stampAuditEvidenceCensus(entries, recordStart) {
  const own = entries.slice(recordStart);
  const auditEvidence = own.filter(isAuditEvidenceEntry);
  const census = Object.freeze({
    deliveryAuditEvidenceEntries: auditEvidence.length,
    deliveryAuditAttemptIdentified: auditEvidence.length > 0
      && auditEvidence.every((entry) => entry.auditAttempt != null)
  });
  for (let index = recordStart; index < entries.length; index += 1) {
    entries[index] = { ...entries[index], ...census };
  }
}

/**
 * Filters ledger entries.
 *
 * Temporal filtering compares real instants (epoch milliseconds), never ISO strings
 * lexicographically, so `...Z` and `...+00:00` behave identically. An entry is in the window
 * when its own terminal instant falls inside it; an entry whose terminal instant is unknown is
 * excluded from any bounded window rather than silently attributed to it, and is reported via
 * `unknownTerminalTimestampEntries`.
 */
export function filterLedgerEntries(entries, {
  from = null,
  to = null,
  repository = null,
  issueNumber = null,
  pullRequestNumber = null,
  phase = null,
  provider = null,
  model = null
} = {}) {
  const fromMs = toInstantMs(from, 'period.from');
  const toMs = toInstantMs(to, 'period.to');
  if (fromMs != null && toMs != null && toMs < fromMs) {
    throw new Error('invalid period: --to must not precede --from');
  }
  return entries.filter((entry) => {
    if (repository && entry.repository !== repository) return false;
    if (issueNumber != null && entry.issueNumber !== issueNumber) return false;
    if (pullRequestNumber != null && entry.pullRequestNumber !== pullRequestNumber) return false;
    if (phase && entry.phase !== phase) return false;
    if (provider && entry.provider !== provider) return false;
    if (model && entry.model !== model) return false;
    if (fromMs == null && toMs == null) return true;
    const endedMs = toInstantMs(entry.endedAtIso, 'entry.endedAtIso');
    if (endedMs == null) return false;
    // Inclusive on both edges: a run terminating exactly on the boundary is inside the window.
    if (fromMs != null && endedMs < fromMs) return false;
    if (toMs != null && endedMs > toMs) return false;
    return true;
  });
}

/** Counts entries that a bounded window had to drop because their terminal instant is unknown. */
export function countUnknownTerminalTimestamps(entries, { from = null, to = null } = {}) {
  if (from == null && to == null) return 0;
  return entries.filter((entry) => entry.endedAtIso == null).length;
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
      // Never coerced to zero: no known observation means the total is genuinely unknown.
      total: knownCount[field] > 0 ? known[field] : null
    });
  }
  return Object.freeze(result);
}

/**
 * Aggregates ledger entries into per-currency cost totals plus usage/call totals.
 *
 * Currencies are never mixed and never converted. Within a currency, reported and estimated are
 * kept as separate running totals for transparency, while `effectiveCost` sums each entry's own
 * precedence-resolved cost (never reported+estimated for the same entry).
 *
 * The unknown counters are deliberately separate, because they mean different things:
 * - `unknownCostEntries`: real provider runs whose cost could not be determined;
 * - `zeroProviderCallEntries`: deliveries proven to have made no provider call (not unknown);
 * - `legacyEntries`: pre-ledger records with delivery-level evidence only.
 *
 * `entriesCount` and `providerCalls` are NOT interchangeable and both are reported:
 * - `entriesCount`: rows of this ledger/projection, including `zero-calls` and `legacy-aggregate`
 *   rows that are not provider calls at all;
 * - `providerCalls`: real provider calls actually known. A `run` row is one call, a `zero-calls`
 *   row proves zero calls, and a `legacy-aggregate` row carries no call identity, so it is
 *   counted in `unknownProviderCallEntries` instead of fabricating calls. A window whose only
 *   evidence is legacy keeps `providerCalls: null` (unknown), never 0.
 *
 * Attempts (`attempts.implementation`/`audit`/`remediation`) are derived from DISTINCT identities,
 * never by summing per-run attempt numbers: several provider runs of the same delivery can belong
 * to the same implementation attempt.
 *
 * Every attempt counter is scoped to the entries actually aggregated here, because this function
 * is also what `groupLedgerEntries` runs over each group. Implementation and remediation attempts
 * come from the run-granular attempt identity the ledger persists, and only from the runs of the
 * corresponding phase, so a group of audit runs never reports the implementation attempts those
 * runs merely happened under.
 *
 * Audit attempts are the delicate case, because the canonical `attempts.audit` is DELIVERY-level.
 * It may only be attributed to this scope when the scope provably covers that delivery's whole
 * audit evidence (`deliveryAuditEvidenceEntries`). Otherwise the scope reports `unknown`/
 * `partial` instead of inheriting a delivery total it does not cover — a group holding only
 * implementation runs must never show the delivery's audit attempts. When the runs themselves
 * carry a run-granular `auditAttempt` identity, any scope is counted exactly from distinct
 * identities and no delivery-level fallback is needed.
 *
 * An entry that cannot carry attempt identity is counted as unknown, so incomplete history stays
 * `partial`/`unknown` instead of being reported as 0. Provider runs are never used as a
 * substitute for an attempt count: `providerRuns`, `providerCalls`, `entriesCount` and the three
 * attempt counters are distinct quantities and all of them are reported.
 */
export function aggregateLedgerEntries(entries) {
  const byCurrency = new Map();
  let unknownCostEntries = 0;
  let zeroProviderCallEntries = 0;
  let legacyEntries = 0;
  let providerRuns = 0;
  let unknownUsageEntries = 0;
  let partialUsageEntries = 0;
  let remediationRuns = 0;
  let auditRuns = 0;
  const deliveries = new Set();
  // Distinct attempt identities, so N provider runs of one attempt stay ONE attempt.
  const implementationAttemptIds = new Set();
  const remediationAttemptIds = new Set();
  // Per-delivery audit bookkeeping, used to decide whether this scope covers a delivery's whole
  // audit evidence before attributing its delivery-level `attempts.audit` to the scope.
  const auditScopeByDelivery = new Map();
  let unknownImplementationAttemptEntries = 0;
  let unknownRemediationAttemptEntries = 0;
  let unknownAuditAttemptEntries = 0;

  const auditScopeOf = (entry) => {
    let scope = auditScopeByDelivery.get(entry.deliveryId);
    if (!scope) {
      scope = {
        canonical: entry.deliveryAuditAttempts ?? null,
        evidenceTotal: entry.deliveryAuditEvidenceEntries ?? null,
        runIdentified: entry.deliveryAuditAttemptIdentified === true,
        evidenceInScope: 0,
        entriesInScope: 0,
        attemptIds: new Set()
      };
      auditScopeByDelivery.set(entry.deliveryId, scope);
    }
    return scope;
  };

  for (const entry of entries) {
    deliveries.add(entry.deliveryId);
    const auditScope = auditScopeOf(entry);
    auditScope.entriesInScope += 1;
    if (isAuditEvidenceEntry(entry)) {
      auditScope.evidenceInScope += 1;
      if (entry.auditAttempt != null) auditScope.attemptIds.add(`${entry.deliveryId}#${entry.auditAttempt}`);
    }
    if (entry.kind === 'zero-calls') {
      zeroProviderCallEntries += 1;
      // A proven zero-call delivery carries no run-level attempt identity; it is unknown here
      // rather than an implementation/remediation attempt of 0.
      unknownImplementationAttemptEntries += 1;
      unknownRemediationAttemptEntries += 1;
      continue;
    }
    if (entry.kind === 'legacy-aggregate') legacyEntries += 1;
    if (entry.kind === 'run') {
      providerRuns += 1;
      if (entry.phase === 'remediation') remediationRuns += 1;
      if (entry.phase === 'audit') auditRuns += 1;
      if (entry.usageAccounting === 'unknown') unknownUsageEntries += 1;
      else if (entry.usageAccounting === 'partial') partialUsageEntries += 1;
    }
    // Implementation and remediation attempts are already scope-safe: the identity lives on the
    // entry itself (`deliveryId#attempt`), so a group only ever counts the attempts its own
    // entries belong to, and several runs of one attempt collapse into that one attempt.
    if (entry.implementationAttempt == null) unknownImplementationAttemptEntries += 1;
    else implementationAttemptIds.add(`${entry.deliveryId}#${entry.implementationAttempt}`);
    if (entry.remediationAttempt == null) unknownRemediationAttemptEntries += 1;
    // `remediationAttempt === 0` means "no remediation happened yet", not a remediation attempt.
    else if (entry.remediationAttempt > 0) remediationAttemptIds.add(`${entry.deliveryId}#${entry.remediationAttempt}`);

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
      reportedCost: Math.round(bucket.reported * 1e6) / 1e6,
      estimatedCost: Math.round(bucket.estimated * 1e6) / 1e6,
      effectiveCost: Math.round(bucket.effective * 1e6) / 1e6,
      accounting: bucket.partial ? 'partial' : 'complete'
    });
  }

  const anyCurrencyPartial = [...byCurrency.values()].some((bucket) => bucket.partial);
  // A window containing only proven zero-provider-call deliveries is COMPLETE, not unknown.
  const accounting = entries.length === 0
    ? 'unknown'
    : (unknownCostEntries > 0 || legacyEntries > 0 || anyCurrencyPartial ? 'partial' : 'complete');

  // Real provider calls. Only `run` (one call each) and `zero-calls` (proven zero) rows carry
  // call identity; legacy rows do not, so a window with no such evidence stays unknown.
  const callEvidenceEntries = providerRuns + zeroProviderCallEntries;
  const providerCalls = callEvidenceEntries > 0 ? providerRuns : null;
  const providerCallsAccounting = providerCalls == null
    ? 'unknown'
    : (legacyEntries > 0 ? 'partial' : 'complete');

  const attemptSummary = (knownCount, unknownEntries, hasKnown) => Object.freeze({
    // Never coerced to zero: no attempt identity at all means genuinely unknown.
    total: hasKnown ? knownCount : null,
    unknownEntries,
    accounting: !hasKnown ? 'unknown' : (unknownEntries > 0 ? 'partial' : 'complete')
  });

  // Audit attempts, resolved per delivery against what THIS scope actually contains.
  let auditAttemptsTotal = 0;
  let resolvedAuditDeliveries = 0;
  for (const scope of auditScopeByDelivery.values()) {
    if (scope.runIdentified) {
      // Every audit run of the delivery carries its own attempt identity, so any scope — a whole
      // delivery, one phase, one workflow run — is counted exactly, including a proven zero for a
      // scope that holds none of them.
      auditAttemptsTotal += scope.attemptIds.size;
      resolvedAuditDeliveries += 1;
      continue;
    }
    if (scope.canonical != null && scope.evidenceTotal != null && scope.evidenceInScope === scope.evidenceTotal) {
      // No run-granular identity, but this scope holds ALL of the delivery's audit evidence (a
      // delivery with no audit evidence at all included), so the canonical delivery-level count
      // is exactly this scope's count.
      auditAttemptsTotal += scope.canonical;
      resolvedAuditDeliveries += 1;
      continue;
    }
    // Partial coverage without run-granular identity: the delivery-level total is NOT this
    // scope's total and must not be inherited. Its entries stay unknown.
    unknownAuditAttemptEntries += scope.entriesInScope;
  }

  const attempts = Object.freeze({
    implementation: attemptSummary(
      implementationAttemptIds.size,
      unknownImplementationAttemptEntries,
      implementationAttemptIds.size > 0
    ),
    audit: attemptSummary(auditAttemptsTotal, unknownAuditAttemptEntries, resolvedAuditDeliveries > 0),
    remediation: attemptSummary(
      remediationAttemptIds.size,
      unknownRemediationAttemptEntries,
      // A run row with a known `remediationAttempt` of 0 proves "zero remediation attempts"; it
      // is a known identity even though it adds nothing to the distinct set.
      unknownRemediationAttemptEntries < entries.length
    )
  });

  return Object.freeze({
    entriesCount: entries.length,
    deliveries: deliveries.size,
    providerRuns,
    providerCalls,
    providerCallsAccounting,
    unknownProviderCallEntries: legacyEntries,
    implementationAttempts: attempts.implementation.total,
    auditAttempts: attempts.audit.total,
    remediationAttempts: attempts.remediation.total,
    attempts,
    zeroProviderCallEntries,
    legacyEntries,
    unknownCostEntries,
    unknownUsageEntries,
    partialUsageEntries,
    remediationRuns,
    auditRuns,
    costByCurrency: Object.freeze(costByCurrency),
    accounting,
    usage: summarizeUsage(entries)
  });
}

/** Grouping dimensions. `issue`/`pr` are the CLI-facing aliases of the record fields. */
export const GROUP_BY_DIMENSIONS = Object.freeze({
  repository: 'repository',
  issue: 'issueNumber',
  pr: 'pullRequestNumber',
  phase: 'phase',
  provider: 'provider',
  model: 'model',
  worker: 'worker',
  role: 'role',
  risk: 'risk',
  delivery: 'deliveryId',
  day: '__day',
  kind: 'kind',
  // Issue #213 requires aggregating by workflow run and by implementation/remediation attempt.
  // The ledger already persists these; these are their CLI-facing names.
  'workflow-run': 'workflowRunId',
  'implementation-attempt': 'implementationAttempt',
  'remediation-attempt': 'remediationAttempt'
});

function dimensionValue(entry, dimension) {
  const field = GROUP_BY_DIMENSIONS[dimension];
  if (!field) throw new Error(`unsupported group-by dimension: ${dimension}`);
  if (field === '__day') return entry.endedAtIso ? entry.endedAtIso.slice(0, 10) : 'unknown';
  const value = entry[field];
  return value == null ? 'unknown' : String(value);
}

export function groupLedgerEntries(entries, groupBy = ['repository', 'phase']) {
  if (!Array.isArray(groupBy) || groupBy.length === 0) throw new Error('groupBy must be a non-empty array');
  for (const dimension of groupBy) {
    if (!GROUP_BY_DIMENSIONS[dimension]) throw new Error(`unsupported group-by dimension: ${dimension}`);
  }
  const groups = new Map();
  for (const entry of entries) {
    const key = groupBy.map((dimension) => dimensionValue(entry, dimension)).join('|');
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
 * Resolves a deterministic period window from CLI-style filters.
 *
 * Boundaries are real instants. UTC is the default; another timezone is accepted only when it is
 * a fixed `±HH:MM` offset, so a window stays reproducible between a local run and CI. A named
 * timezone is rejected rather than silently reinterpreted as UTC.
 */
export function resolvePeriod({
  period = null, today = false, month = null, from = null, to = null,
  timezone = 'UTC', nowMs = Date.now()
} = {}) {
  const requestedTimezone = requireString(timezone, 'timezone');
  const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(requestedTimezone);
  const isUtc = requestedTimezone.toUpperCase() === 'UTC' || requestedTimezone === 'Z';
  if (!isUtc && !offsetMatch) {
    throw new Error(`unsupported timezone: ${requestedTimezone} (use UTC or a fixed ±HH:MM offset)`);
  }
  const offsetMs = offsetMatch
    ? (offsetMatch[1] === '-' ? -1 : 1) * ((Number(offsetMatch[2]) * 60) + Number(offsetMatch[3])) * 60_000
    : 0;
  const resolvedTimezone = isUtc ? 'UTC' : requestedTimezone;

  const windowOf = (startMs, endMs) => Object.freeze({
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    timezone: resolvedTimezone
  });

  const resolvedPeriod = period ?? (today ? 'today' : (month ? 'month' : null));

  if (resolvedPeriod === 'today') {
    // Local-day boundaries in the requested fixed offset, expressed as real UTC instants.
    const localDayStart = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
    return windowOf(localDayStart, localDayStart + 86_400_000 - 1);
  }

  if (resolvedPeriod === '7d') {
    const localDayStart = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
    return windowOf(localDayStart - (6 * 86_400_000), localDayStart + 86_400_000 - 1);
  }

  if (resolvedPeriod === 'month') {
    const anchor = new Date(nowMs + offsetMs);
    const isExplicit = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month);
    const [year, monthNumber] = isExplicit
      ? month.split('-').map(Number)
      : [anchor.getUTCFullYear(), anchor.getUTCMonth() + 1];
    const start = Date.UTC(year, monthNumber - 1, 1) - offsetMs;
    const end = Date.UTC(year, monthNumber, 1) - offsetMs - 1;
    return windowOf(start, end);
  }

  if (resolvedPeriod === 'custom' && (from == null || to == null)) {
    throw new Error('period "custom" requires both --from and --to');
  }

  const fromMs = toInstantMs(from, '--from');
  const toMs = toInstantMs(to, '--to');
  if (fromMs != null && toMs != null && toMs < fromMs) {
    throw new Error('invalid period: --to must not precede --from');
  }
  return Object.freeze({
    from: fromMs == null ? null : new Date(fromMs).toISOString(),
    to: toMs == null ? null : new Date(toMs).toISOString(),
    timezone: resolvedTimezone
  });
}

/**
 * Builds the full AI Usage & Cost report from the single operational metrics store. This is the
 * one aggregation function every consumer (CLI human output, JSON, CSV, HTML, Job Summary) must
 * call, so totals never diverge between output formats.
 */
export async function buildAiUsageReport({
  metricsFile,
  period = null,
  today = false,
  month = null,
  from = null,
  to = null,
  timezone = 'UTC',
  repository = null,
  issueNumber = null,
  pullRequestNumber = null,
  phase = null,
  provider = null,
  model = null,
  groupBy = ['repository', 'phase'],
  allowMissingStore = false,
  nowMs = Date.now()
} = {}) {
  const store = await loadOperationalMetricsStore(metricsFile, { allowMissing: allowMissingStore });
  const entries = deriveLedgerEntries(store.records);
  const resolved = resolvePeriod({ period, today, month, from, to, timezone, nowMs });
  const filters = { repository, issueNumber, pullRequestNumber, phase, provider, model };
  const filtered = filterLedgerEntries(entries, { from: resolved.from, to: resolved.to, ...filters });
  const scoped = filterLedgerEntries(entries, filters);

  return Object.freeze({
    schemaVersion: AI_USAGE_LEDGER_SCHEMA_VERSION,
    generatedAtIso: new Date(nowMs).toISOString(),
    storePath: store.storePath,
    storePresent: store.present,
    period: resolved,
    filters: Object.freeze(filters),
    totalDeliveries: store.records.length,
    // Entries dropped from a bounded window purely because their own terminal instant is
    // unknown; surfaced so an empty window is never mistaken for "nothing was spent".
    unknownTerminalTimestampEntries: countUnknownTerminalTimestamps(scoped, { from: resolved.from, to: resolved.to }),
    totals: aggregateLedgerEntries(filtered),
    groups: groupLedgerEntries(filtered, groupBy),
    byDay: groupLedgerEntries(filtered, ['day']),
    byRepository: groupLedgerEntries(filtered, ['repository']),
    byPhase: groupLedgerEntries(filtered, ['phase']),
    byProviderModel: groupLedgerEntries(filtered, ['provider', 'model']),
    byIssue: groupLedgerEntries(filtered, ['repository', 'issue']),
    byPullRequest: groupLedgerEntries(filtered, ['repository', 'pr']),
    entries: Object.freeze(filtered)
  });
}
