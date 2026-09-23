/**
 * Delivery-closing "AI usage" summary (issue #213).
 *
 * Renders the per-delivery AI usage/cost block that closes a delivery, strictly from the
 * delivery's own provider-run ledger. It never fabricates completeness: when any provider run
 * has unknown cost or unknown usage, the accounting line says `partial`, and unknown values are
 * printed as `unknown` rather than as zero. Currencies are reported side by side and never
 * summed or converted.
 */

const PHASE_LABELS = Object.freeze({
  implementation: 'Implementation',
  remediation: 'Remediation',
  audit: 'Audit',
  'technical-hygiene': 'Technical hygiene'
});

function formatTokens(value) {
  return value == null ? 'unknown' : String(value);
}

function formatAmount(amount) {
  return Number.isInteger(amount) ? amount.toFixed(2) : String(Math.round(amount * 1e6) / 1e6);
}

/**
 * Aggregates a single delivery's ledger into the closing-summary shape.
 * `providerRunAccounting` distinguishes a fully-enumerated delivery (including a proven
 * zero-provider-call delivery) from a legacy or partially-observed one.
 */
export function summarizeDeliveryAiUsage(metrics) {
  if (metrics == null) return null;
  const ledger = metrics.providerRunLedger ?? [];
  const runAccounting = metrics.providerRunAccounting ?? 'legacy';

  const byPhase = new Map();
  const costByCurrency = new Map();
  let unknownCostRuns = 0;
  let unknownUsageRuns = 0;
  let inputTokens = null;
  let outputTokens = null;

  for (const run of ledger) {
    const phase = run.phase;
    if (!byPhase.has(phase)) byPhase.set(phase, { calls: 0, inputTokens: null, outputTokens: null });
    const bucket = byPhase.get(phase);
    bucket.calls += 1;
    if (run.usage.inputTokens != null) bucket.inputTokens = (bucket.inputTokens ?? 0) + run.usage.inputTokens;
    if (run.usage.outputTokens != null) bucket.outputTokens = (bucket.outputTokens ?? 0) + run.usage.outputTokens;
    if (run.usage.inputTokens != null) inputTokens = (inputTokens ?? 0) + run.usage.inputTokens;
    if (run.usage.outputTokens != null) outputTokens = (outputTokens ?? 0) + run.usage.outputTokens;

    if (run.usageAccounting !== 'complete') unknownUsageRuns += 1;

    const cost = run.effectiveCost;
    if (!cost) {
      unknownCostRuns += 1;
      continue;
    }
    costByCurrency.set(cost.currency, (costByCurrency.get(cost.currency) ?? 0) + cost.amount);
  }

  const complete = runAccounting === 'complete' && unknownCostRuns === 0 && unknownUsageRuns === 0;

  return Object.freeze({
    providerRunAccounting: runAccounting,
    // `complete` only when every provider run of this delivery has both known usage and known
    // cost AND the controller enumerated every run. Anything else is honestly `partial`.
    accounting: complete ? 'complete' : 'partial',
    aiCalls: ledger.length,
    byPhase: Object.freeze(Object.fromEntries([...byPhase.entries()].sort(([a], [b]) => a.localeCompare(b)))),
    knownCostByCurrency: Object.freeze(Object.fromEntries(
      [...costByCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amount]) => [currency, Math.round(amount * 1e6) / 1e6])
    )),
    unknownCostRuns,
    unknownUsageRuns,
    inputTokens,
    outputTokens
  });
}

/** Renders the summary as the fixed-width text block the issue specifies. */
export function renderDeliveryAiUsageSummary(summary) {
  if (summary == null) return '';
  const lines = ['## AI usage', ''];

  const phases = Object.keys(summary.byPhase);
  if (phases.length === 0) {
    lines.push('No provider runs recorded for this delivery.');
  }
  for (const phase of phases) {
    const bucket = summary.byPhase[phase];
    const label = PHASE_LABELS[phase] ?? phase;
    lines.push(
      `${label.padEnd(17)}${String(bucket.calls).padStart(3)} call(s), ` +
      `in ${formatTokens(bucket.inputTokens)} / out ${formatTokens(bucket.outputTokens)}`
    );
  }

  lines.push('-'.repeat(20));
  lines.push('');

  const currencies = Object.entries(summary.knownCostByCurrency);
  lines.push(`${'Known cost'.padEnd(17)}${currencies.length === 0
    ? 'unknown'
    : currencies.map(([currency, amount]) => `${currency} ${formatAmount(amount)}`).join(' + ')}`);
  lines.push(`${'Unknown cost runs'.padEnd(17)} ${summary.unknownCostRuns}`);
  lines.push(`${'Accounting'.padEnd(17)}${summary.accounting}`);
  lines.push('');
  lines.push(`${'Input tokens'.padEnd(17)}${formatTokens(summary.inputTokens)}`);
  lines.push(`${'Output tokens'.padEnd(17)}${formatTokens(summary.outputTokens)}`);
  lines.push(`${'AI calls'.padEnd(17)}${summary.aiCalls}`);

  return `${lines.join('\n')}\n`;
}
