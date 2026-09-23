import { createDeliveryMetrics } from './metrics.mjs';
import { mergeGhAwUsage, normalizeGhAwUsage, extractGhAwRunEvidence } from './usage-telemetry.mjs';
import { estimateProviderRunCost } from './ai-pricing.mjs';

const STAGES = new Set(['implementation', 'audit']);
const PHASE_RE = /^[a-z0-9][a-z0-9._-]*$/;

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

function nullableIso(value, label) {
  if (value == null) return null;
  const iso = requiredString(value, label);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid ISO-8601 timestamp`);
  return new Date(ms).toISOString();
}

function nullableString(value, label, { lower = false } = {}) {
  if (value == null) return null;
  const text = requiredString(value, label);
  return lower ? text.toLowerCase() : text;
}

function nullableNonNegativeInteger(value, label) {
  if (value == null) return null;
  return nonNegativeInteger(value, label);
}

function normalizeCostInput(value, label) {
  if (value == null) return null;
  const cost = requiredObject(value, label);
  const amount = cost.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error(`${label}.amount must be a non-negative finite number`);
  }
  return Object.freeze({ amount, currency: requiredString(cost.currency, `${label}.currency`).toUpperCase() });
}

/**
 * Normalizes one accumulated provider-run ledger entry.
 *
 * The accumulator is persisted between controller invocations (resume/recovery) inside the
 * managed state comment, so every entry must survive a JSON round-trip unchanged. Nothing is
 * defaulted to zero here: a counter or timestamp the controller never observed stays `null`.
 */
function normalizeLedgerEntry(value, label) {
  const entry = requiredObject(value, label);
  const phase = requiredString(entry.phase, `${label}.phase`).toLowerCase();
  if (!PHASE_RE.test(phase)) throw new Error(`invalid ${label}.phase: ${phase}`);
  const pricingSnapshot = entry.pricingSnapshot == null ? null : requiredObject(entry.pricingSnapshot, `${label}.pricingSnapshot`);
  const estimatedCost = normalizeCostInput(entry.estimatedCost, `${label}.estimatedCost`);
  if (estimatedCost && !pricingSnapshot) {
    throw new Error(`${label}.estimatedCost requires a pricingSnapshot`);
  }
  return Object.freeze({
    runId: positiveInteger(entry.runId, `${label}.runId`),
    workflowRunId: entry.workflowRunId == null ? null : positiveInteger(entry.workflowRunId, `${label}.workflowRunId`),
    materialHeadSha: nullableString(entry.materialHeadSha, `${label}.materialHeadSha`, { lower: true }),
    phase,
    provider: requiredString(entry.provider, `${label}.provider`).toLowerCase(),
    model: nullableString(entry.model, `${label}.model`),
    worker: nullableString(entry.worker, `${label}.worker`),
    role: nullableString(entry.role, `${label}.role`, { lower: true }),
    implementationAttempt: nullableNonNegativeInteger(entry.implementationAttempt, `${label}.implementationAttempt`),
    remediationAttempt: nullableNonNegativeInteger(entry.remediationAttempt, `${label}.remediationAttempt`),
    auditAttempt: nullableNonNegativeInteger(entry.auditAttempt, `${label}.auditAttempt`),
    usage: normalizeGhAwUsage(entry.usage ?? {}),
    cache: Object.freeze({
      cacheReadInputTokens: nullableNonNegativeInteger(entry.cache?.cacheReadInputTokens ?? null, `${label}.cache.cacheReadInputTokens`),
      cacheCreationInputTokens: nullableNonNegativeInteger(entry.cache?.cacheCreationInputTokens ?? null, `${label}.cache.cacheCreationInputTokens`)
    }),
    reportedCost: normalizeCostInput(entry.reportedCost, `${label}.reportedCost`),
    estimatedCost,
    pricingSnapshot: pricingSnapshot == null ? null : Object.freeze({ ...pricingSnapshot }),
    startedAtIso: nullableIso(entry.startedAtIso, `${label}.startedAtIso`),
    endedAtIso: nullableIso(entry.endedAtIso, `${label}.endedAtIso`),
    observedAtIso: nullableIso(entry.observedAtIso, `${label}.observedAtIso`),
    terminalState: nullableString(entry.terminalState, `${label}.terminalState`, { lower: true }),
    evidenceRef: nullableString(entry.evidenceRef, `${label}.evidenceRef`)
  });
}

function normalizeLedger(value, label = 'observability.providerRunLedger') {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const entries = value.map((item, index) => normalizeLedgerEntry(item, `${label}[${index}]`));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.runId)) throw new Error(`${label} contains duplicate runId: ${entry.runId}`);
    seen.add(entry.runId);
  }
  return Object.freeze(entries);
}

export function createControllerObservability({ startedAtMs = Date.now() } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    startedAtMs: nonNegativeInteger(startedAtMs, 'startedAtMs'),
    providerCalls: 0,
    providerRunIds: Object.freeze([]),
    observedRunIds: Object.freeze([]),
    // One entry per *billable* provider run, in observation order. A run observed to have made
    // zero provider calls is deliberately absent here (it is counted in zeroProviderCallRuns)
    // so it is never mistaken for a provider run of unknown cost.
    providerRunLedger: Object.freeze([]),
    providerLedgerHistoryComplete: true,
    zeroProviderCallRuns: 0,
    providerAccountingComplete: true,
    failedAuditRunIds: Object.freeze([]),
    auditTimingComplete: true,
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
  const providerRunLedger = normalizeLedger(value.providerRunLedger);

  if (providerRunLedger.length > providerCalls) {
    throw new Error(
      'observability.providerRunLedger cannot contain more entries than providerCalls'
    );
  }

  for (const entry of providerRunLedger) {
    if (!normalizedRunIds.includes(entry.runId)) {
      throw new Error(
        `observability.providerRunLedger runId ${entry.runId} is not present in providerRunIds`
      );
    }
  }

  const inferredProviderLedgerHistoryComplete =
    providerRunLedger.length === providerCalls;

  const providerLedgerHistoryComplete =
    value.providerLedgerHistoryComplete == null
      ? inferredProviderLedgerHistoryComplete
      : value.providerLedgerHistoryComplete;

  if (typeof providerLedgerHistoryComplete !== 'boolean') {
    throw new Error(
      'observability.providerLedgerHistoryComplete must be boolean when present'
    );
  }

  if (
    providerLedgerHistoryComplete &&
    !inferredProviderLedgerHistoryComplete
  ) {
    throw new Error(
      'complete provider ledger history requires one ledger entry per provider call'
    );
  }

  const zeroProviderCallRuns = nonNegativeInteger(value.zeroProviderCallRuns ?? 0, 'observability.zeroProviderCallRuns');

  const hasAnyProviderAccountingField = [
    'providerAccountingComplete',
    'failedAuditRunIds',
    'auditTimingComplete'
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));

  const hasCompleteProviderAccountingFields =
    typeof value.providerAccountingComplete === 'boolean' &&
    Array.isArray(value.failedAuditRunIds) &&
    typeof value.auditTimingComplete === 'boolean';

  if (hasAnyProviderAccountingField && !hasCompleteProviderAccountingFields) {
    throw new Error('controller observability provider accounting fields must be complete when present');
  }

  const providerAccountingComplete = hasCompleteProviderAccountingFields
    ? value.providerAccountingComplete
    : false;

  const failedAuditRunIds = hasCompleteProviderAccountingFields
    ? normalizeRunIds(value.failedAuditRunIds, 'observability.failedAuditRunIds')
    : [];

  const auditTimingComplete = hasCompleteProviderAccountingFields
    ? value.auditTimingComplete
    : false;

  if (providerAccountingComplete && failedAuditRunIds.length > 0) {
    throw new Error('complete provider accounting cannot contain failed audit runs with unknown provider usage');
  }

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
    providerRunLedger,
    providerLedgerHistoryComplete,
    zeroProviderCallRuns,
    providerAccountingComplete,
    failedAuditRunIds: Object.freeze(failedAuditRunIds),
    auditTimingComplete,
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

/**
 * Records one observed provider run into the canonical controller accumulator.
 *
 * This is the single operational place where a provider run becomes a ledger entry: the CLI,
 * the workflow and the closing summary all read what this function accumulated, so there is no
 * second observability path. Identity/dedup uses `observedRunIds` — exactly the same canonical
 * provider-run identity the controller already used before this ledger existed — which makes
 * re-entry, resume and recovery idempotent: re-observing an already-accounted run is a no-op.
 *
 * `usage.providerCalls === 0` marks a run *proven* to have made no provider call. Such a run is
 * recorded as observed (so it is never re-dispatched) and counted in `zeroProviderCallRuns`, but
 * it produces no ledger entry: a proven zero-call run is not a provider run of unknown cost.
 *
 * `rawUsagePayload` is the untouched provider usage artifact, used only to extract model /
 * reported cost / run timestamps / cache counters. When no cost is reported and a pricing
 * catalog is supplied, `estimatedCost` is derived from committed pricing and the exact rates are
 * frozen into `pricingSnapshot`, so a later pricing change cannot rewrite this run's cost.
 */
export function recordControllerProviderObservation(raw, {
  runId,
  stage,
  usage = {},
  durationMs = null,
  evidenceRef = null,
  phase = null,
  provider = null,
  model = null,
  worker = null,
  role = null,
  workflowRunId = null,
  materialHeadSha = null,
  implementationAttempt = null,
  remediationAttempt = null,
  auditAttempt = null,
  terminalState = null,
  startedAtIso = null,
  endedAtIso = null,
  observedAtIso = null,
  reportedCost = null,
  rawUsagePayload = null,
  pricingCatalog = null
} = {}) {
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
      zeroProviderCallRuns: current.zeroProviderCallRuns + 1,
      auditDurationMs,
      evidenceRefs: normalizeRefs(refs)
    });
  }

  const normalizedUsage = normalizeGhAwUsage(usage);
  const nextUsage = mergeGhAwUsage([current.aiUsageByStage[resolvedStage], normalizedUsage]);

  const evidence = extractGhAwRunEvidence(rawUsagePayload ?? usage);
  const resolvedProvider = nullableString(provider, 'provider', { lower: true }) ?? evidence.provider;
  if (!resolvedProvider) {
    throw new Error(`provider is unknown for provider run ${resolvedRunId}; refusing to record an unattributable ledger entry`);
  }
  const resolvedModel = nullableString(model, 'model') ?? evidence.model;
  const resolvedReportedCost = normalizeCostInput(reportedCost, 'reportedCost') ?? evidence.reportedCost;

  // reported cost always wins; an estimate is only derived when nothing was metered, and the two
  // are never both applied to the same run.
  const estimate = resolvedReportedCost
    ? null
    : estimateProviderRunCost({ provider: resolvedProvider, model: resolvedModel, usage: normalizedUsage }, pricingCatalog);

  const ledgerEntry = normalizeLedgerEntry({
    runId: resolvedRunId,
    workflowRunId,
    materialHeadSha,
    phase: nullableString(phase, 'phase', { lower: true }) ?? resolvedStage,
    provider: resolvedProvider,
    model: resolvedModel,
    worker,
    role,
    implementationAttempt,
    remediationAttempt,
    auditAttempt,
    usage: normalizedUsage,
    cache: {
      cacheReadInputTokens: evidence.cacheReadInputTokens,
      cacheCreationInputTokens: evidence.cacheCreationInputTokens
    },
    reportedCost: resolvedReportedCost,
    estimatedCost: estimate ? { amount: estimate.amount, currency: estimate.currency } : null,
    pricingSnapshot: estimate ? estimate.pricingSnapshot : null,
    startedAtIso: startedAtIso ?? evidence.startedAtIso,
    // The terminal timestamp is only ever the run's own observed end. It is never back-filled
    // from the delivery-level timestamp or from "now".
    endedAtIso: endedAtIso ?? evidence.endedAtIso,
    observedAtIso,
    terminalState,
    evidenceRef
  }, `providerRunLedger[${resolvedRunId}]`);

  return Object.freeze({
    ...current,
    providerCalls: current.providerCalls + 1,
    providerRunIds: Object.freeze([...current.providerRunIds, resolvedRunId]),
    observedRunIds,
    providerRunLedger: Object.freeze([...current.providerRunLedger, ledgerEntry]),
    aiUsageByStage: Object.freeze({
      ...current.aiUsageByStage,
      [resolvedStage]: nextUsage
    }),
    auditDurationMs,
    evidenceRefs: normalizeRefs(refs)
  });
}

export function recordControllerAuditWorkflowFailure(
  raw,
  { runId, durationMs = null, evidenceRef = null } = {}
) {
  const current = normalizeControllerObservability(raw);
  const resolvedRunId = positiveInteger(runId, 'runId');

  if (
    current.observedRunIds.includes(resolvedRunId) ||
    current.failedAuditRunIds.includes(resolvedRunId)
  ) {
    return current;
  }

  const durationKnown = durationMs != null;
  const resolvedDuration = durationKnown
    ? nonNegativeInteger(durationMs, 'durationMs')
    : 0;

  const refs = evidenceRef
    ? [...current.evidenceRefs, requiredString(evidenceRef, 'evidenceRef')]
    : [...current.evidenceRefs];

  return Object.freeze({
    ...current,
    providerAccountingComplete: false,
    failedAuditRunIds: Object.freeze([
      ...current.failedAuditRunIds,
      resolvedRunId
    ]),
    auditTimingComplete: current.auditTimingComplete && durationKnown,
    auditDurationMs: current.auditDurationMs + resolvedDuration,
    evidenceRefs: normalizeRefs(refs)
  });
}

export function createControllerPartialMetrics({
  observability,
  terminalReason,
  nowMs = Date.now()
} = {}) {
  const observed = normalizeControllerObservability(observability);

  return Object.freeze({
    schemaVersion: 1,
    providerCalls: observed.providerAccountingComplete
      ? observed.providerCalls
      : null,
    observedProviderCalls: observed.providerCalls,
    providerAccountingComplete: observed.providerAccountingComplete,
    providerRunLedger: observed.providerRunLedger,
    zeroProviderCallRuns: observed.zeroProviderCallRuns,
    aiUsageByStage: observed.aiUsageByStage,
    durationsMs: Object.freeze({
      ciQueue: observed.ciTimingHistoryComplete
        ? observed.ciQueueDurationMs
        : null,
      ciExecution: observed.ciTimingHistoryComplete
        ? observed.ciExecutionDurationMs
        : null,
      audit: observed.auditTimingComplete
        ? observed.auditDurationMs
        : null,
      endToEnd: Math.max(
        0,
        nonNegativeInteger(nowMs, 'nowMs') - observed.startedAtMs
      )
    }),
    terminalReason: requiredString(terminalReason, 'terminalReason'),
    evidenceRefs: observed.evidenceRefs
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

/**
 * Rolls the per-run ledger up into the single-valued, delivery-level `providerCost`.
 *
 * This roll-up is deliberately conservative. It only produces a value when every provider run in
 * the delivery resolved to a known cost in one single currency with one single provenance.
 * A delivery mixing currencies, mixing reported and estimated runs, or containing any
 * unknown-cost run reports `unknown` at this level rather than a misleading scalar — the
 * per-run ledger stays the authoritative source, and the report aggregates it per currency.
 * Currencies are never added together and reported/estimated are never summed.
 */
function deliveryProviderCostFrom(ledger) {
  const unavailable = { available: false, amount: null, currency: null };
  if (ledger.length === 0) return unavailable;

  const currencies = new Set();
  const sources = new Set();
  let total = 0;
  for (const entry of ledger) {
    const cost = entry.reportedCost ?? entry.estimatedCost;
    if (!cost) return unavailable;
    currencies.add(cost.currency);
    sources.add(entry.reportedCost ? 'reported' : 'estimated');
    total += cost.amount;
  }
  if (currencies.size !== 1 || sources.size !== 1) return unavailable;

  const currency = [...currencies][0];
  const amount = Math.round(total * 1e6) / 1e6;
  return [...sources][0] === 'reported'
    ? { reportedCost: { amount, currency }, estimatedCost: null }
    : { reportedCost: null, estimatedCost: { amount, currency } };
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
  if (!observed.providerAccountingComplete) {
    throw new Error('provider accounting is incomplete; refusing to publish complete delivery metrics');
  }
  if (!observed.auditTimingComplete) {
    throw new Error('audit timing history is incomplete; refusing to publish complete delivery metrics');
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
    // A partial historical ledger must never be promoted to a complete
    // delivery-level cost. Known per-run values remain reportable through
    // providerRunLedger, while the aggregate stays unknown until every
    // provider call has a ledger entry.
    providerCost: observed.providerLedgerHistoryComplete
      ? deliveryProviderCostFrom(observed.providerRunLedger)
      : { available: false, amount: null, currency: null },
    providerRunLedger: observed.providerRunLedger,
    providerRunAccounting: observed.providerLedgerHistoryComplete
      ? 'complete'
      : 'partial',
    observedAtIso: new Date(nonNegativeInteger(nowMs, 'nowMs')).toISOString(),
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