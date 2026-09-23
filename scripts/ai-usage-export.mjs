#!/usr/bin/env node
// Renders CSV/HTML/Job Summary views from a single ai-usage-report.mjs JSON payload, so every
// exported artifact agrees on totals by construction (there is no separate aggregation here —
// every number below is read straight off the shared payload produced by buildAiUsageReport).
//
// `unknown` is preserved explicitly in every format: an absent usage/cost value is rendered as
// the literal `unknown`, never as 0, and currencies are listed separately, never summed.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UNKNOWN = 'unknown';

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function totalOrUnknown(summary) {
  return summary?.total == null ? UNKNOWN : summary.total;
}

function costCells(group) {
  const currencies = Object.keys(group.costByCurrency);
  if (currencies.length === 0) return [[UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]];
  return currencies.map((currency) => {
    const cost = group.costByCurrency[currency];
    return [currency, cost.reportedCost, cost.estimatedCost, cost.effectiveCost];
  });
}

/**
 * Per-group rows carrying cost *and* usage/calls/attempts, so the CSV supports usage analysis
 * and not only spend. One row per (group, currency); a group with no known cost gets one row
 * with explicit `unknown` cost cells while keeping its usage/call counters.
 */
export function toCsv(report) {
  const rows = [[
    'group', 'currency', 'reportedCost', 'estimatedCost', 'effectiveCost', 'costAccounting',
    'entries', 'providerRuns', 'deliveries', 'zeroProviderCallEntries', 'legacyEntries',
    'unknownCostEntries', 'unknownUsageEntries', 'partialUsageEntries',
    'inputTokens', 'outputTokens', 'totalTokens', 'turns', 'credits',
    'remediationRuns', 'auditRuns'
  ]];
  for (const [key, group] of Object.entries(report.groups)) {
    for (const [currency, reported, estimated, effective] of costCells(group)) {
      rows.push([
        key, currency, reported, estimated, effective, group.accounting,
        group.entriesCount, group.providerRuns, group.deliveries,
        group.zeroProviderCallEntries, group.legacyEntries,
        group.unknownCostEntries, group.unknownUsageEntries, group.partialUsageEntries,
        totalOrUnknown(group.usage.inputTokens), totalOrUnknown(group.usage.outputTokens),
        totalOrUnknown(group.usage.totalTokens), totalOrUnknown(group.usage.turns),
        totalOrUnknown(group.usage.credits),
        group.remediationRuns, group.auditRuns
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatCost(group) {
  const currencies = Object.entries(group.costByCurrency);
  if (currencies.length === 0) return UNKNOWN;
  // Side by side, never summed across currencies and never converted.
  return currencies.map(([currency, cost]) => `${currency} ${cost.effectiveCost}`).join(' + ');
}

function breakdownTable(title, groups, { labelHeader = 'Group' } = {}) {
  const rows = Object.entries(groups).map(([key, group]) => `<tr>
    <td>${escapeHtml(key)}</td>
    <td>${escapeHtml(formatCost(group))}</td>
    <td>${group.providerRuns}</td>
    <td>${escapeHtml(String(totalOrUnknown(group.usage.inputTokens)))}</td>
    <td>${escapeHtml(String(totalOrUnknown(group.usage.outputTokens)))}</td>
    <td>${group.unknownCostEntries}</td>
    <td>${escapeHtml(group.accounting)}</td>
  </tr>`).join('\n');
  return `<h2>${escapeHtml(title)}</h2>
<table>
<thead><tr><th>${escapeHtml(labelHeader)}</th><th>Known effective cost</th><th>Provider runs</th><th>Input tokens</th><th>Output tokens</th><th>Unknown cost</th><th>Accounting</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">no entries in window</td></tr>'}
</tbody>
</table>`;
}

/**
 * Ranks groups by absolute known consumption. Groups whose cost is unknown cannot be ranked by
 * spend, so they are ranked by token consumption and flagged, rather than treated as zero.
 */
function topConsumers(groups, limit = 10) {
  return Object.entries(groups)
    .map(([key, group]) => ({
      key,
      group,
      cost: Object.values(group.costByCurrency).reduce((max, cost) => Math.max(max, cost.effectiveCost), 0),
      tokens: group.usage.totalTokens.total ?? 0
    }))
    .sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens))
    .slice(0, limit);
}

function topTable(title, groups) {
  const rows = topConsumers(groups).map(({ key, group }) => `<tr>
    <td>${escapeHtml(key)}</td>
    <td>${escapeHtml(formatCost(group))}</td>
    <td>${escapeHtml(String(totalOrUnknown(group.usage.totalTokens)))}</td>
    <td>${group.providerRuns}</td>
    <td>${group.remediationRuns}</td>
    <td>${group.auditRuns}</td>
  </tr>`).join('\n');
  return `<h2>${escapeHtml(title)}</h2>
<table>
<thead><tr><th>Key</th><th>Known effective cost</th><th>Total tokens</th><th>Provider runs</th><th>Remediations</th><th>Audits</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">no entries in window</td></tr>'}
</tbody>
</table>`;
}

export function toHtml(report) {
  const { totals, period } = report;
  const currencyRows = Object.entries(totals.costByCurrency)
    .map(([currency, cost]) => `<tr><td>${escapeHtml(currency)}</td><td>${cost.reportedCost}</td><td>${cost.estimatedCost}</td><td>${cost.effectiveCost}</td><td>${escapeHtml(cost.accounting)}</td></tr>`)
    .join('\n') || `<tr><td colspan="5">${UNKNOWN} — no known cost in window</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Usage &amp; Cost Report</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 72rem; padding: 1.5rem 1rem; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid currentColor; padding: 0.35rem 0.5rem; text-align: left; }
  th { font-weight: 600; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
  dt { font-weight: 600; }
  dd { margin: 0; }
</style>
</head>
<body>
<h1>AI Usage &amp; Cost Report</h1>
<dl>
  <dt>Period</dt><dd>${escapeHtml(period.from ?? 'all-time')} .. ${escapeHtml(period.to ?? 'now')}</dd>
  <dt>Timezone</dt><dd>${escapeHtml(period.timezone)}</dd>
  <dt>Generated</dt><dd>${escapeHtml(report.generatedAtIso)}</dd>
  <dt>Store</dt><dd>${escapeHtml(report.storePath)}</dd>
  <dt>Deliveries</dt><dd>${totals.deliveries} in window (${report.totalDeliveries} in store)</dd>
  <dt>Provider runs / calls</dt><dd>${totals.providerRuns} runs, ${totals.entriesCount} ledger entries</dd>
  <dt>Input tokens</dt><dd>${escapeHtml(String(totalOrUnknown(totals.usage.inputTokens)))}</dd>
  <dt>Output tokens</dt><dd>${escapeHtml(String(totalOrUnknown(totals.usage.outputTokens)))}</dd>
  <dt>Total tokens</dt><dd>${escapeHtml(String(totalOrUnknown(totals.usage.totalTokens)))}</dd>
  <dt>Credits</dt><dd>${escapeHtml(String(totalOrUnknown(totals.usage.credits)))}</dd>
  <dt>Unknown-cost provider runs</dt><dd>${totals.unknownCostEntries}</dd>
  <dt>Unknown / partial usage</dt><dd>${totals.unknownUsageEntries} unknown, ${totals.partialUsageEntries} partial</dd>
  <dt>Proven zero-call deliveries</dt><dd>${totals.zeroProviderCallEntries}</dd>
  <dt>Legacy entries</dt><dd>${totals.legacyEntries}</dd>
  <dt>Audits</dt><dd>${totals.auditRuns}</dd>
  <dt>Remediations</dt><dd>${totals.remediationRuns}</dd>
  <dt>Excluded (unknown terminal timestamp)</dt><dd>${report.unknownTerminalTimestampEntries}</dd>
  <dt>Overall accounting</dt><dd><strong>${escapeHtml(totals.accounting)}</strong></dd>
</dl>

<h2>Known effective cost by currency</h2>
<table>
<thead><tr><th>Currency</th><th>Reported</th><th>Estimated</th><th>Effective</th><th>Accounting</th></tr></thead>
<tbody>
${currencyRows}
</tbody>
</table>

${breakdownTable('Cost per day', report.byDay, { labelHeader: 'Day (terminal instant, UTC)' })}
${breakdownTable('Cost per repository', report.byRepository, { labelHeader: 'Repository' })}
${breakdownTable('Cost per phase', report.byPhase, { labelHeader: 'Phase' })}
${breakdownTable('Cost per provider / model', report.byProviderModel, { labelHeader: 'Provider | Model' })}
${topTable('Highest absolute consumption — issues', report.byIssue)}
${topTable('Highest absolute consumption — pull requests', report.byPullRequest)}
${breakdownTable('Requested breakdown', report.groups)}
${report.budget.warnings.length > 0
    ? `<h2>Budget warnings (informative only, never blocking)</h2><ul>${report.budget.warnings.map((warning) => `<li>${escapeHtml(warning.type)}: ${escapeHtml(JSON.stringify(warning))}</li>`).join('')}</ul>`
    : ''}
</body>
</html>
`;
}

/** Mirrors the CLI's principal metrics, from the same payload. */
export function toJobSummary(report) {
  const { totals, period } = report;
  const lines = [];
  lines.push('## AI Usage & Cost Report');
  lines.push('');
  lines.push(`Period: \`${period.from ?? 'all-time'}\` .. \`${period.to ?? 'now'}\` (${period.timezone})`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Deliveries in window | ${totals.deliveries} (${report.totalDeliveries} in store) |`);
  lines.push(`| Provider runs | ${totals.providerRuns} |`);
  lines.push(`| Ledger entries | ${totals.entriesCount} |`);
  lines.push(`| Input tokens | ${totalOrUnknown(totals.usage.inputTokens)} |`);
  lines.push(`| Output tokens | ${totalOrUnknown(totals.usage.outputTokens)} |`);
  lines.push(`| Total tokens | ${totalOrUnknown(totals.usage.totalTokens)} |`);
  lines.push(`| Credits | ${totalOrUnknown(totals.usage.credits)} |`);
  lines.push(`| Unknown-cost provider runs | ${totals.unknownCostEntries} |`);
  lines.push(`| Unknown / partial usage | ${totals.unknownUsageEntries} / ${totals.partialUsageEntries} |`);
  lines.push(`| Proven zero-call deliveries | ${totals.zeroProviderCallEntries} |`);
  lines.push(`| Legacy entries | ${totals.legacyEntries} |`);
  lines.push(`| Audits | ${totals.auditRuns} |`);
  lines.push(`| Remediations | ${totals.remediationRuns} |`);
  lines.push(`| Excluded (unknown terminal timestamp) | ${report.unknownTerminalTimestampEntries} |`);
  lines.push(`| Accounting | **${totals.accounting}** |`);
  lines.push('');
  lines.push('### Known effective cost by currency');
  lines.push('');
  lines.push('| Currency | Reported | Estimated | Effective | Accounting |');
  lines.push('| --- | --- | --- | --- | --- |');
  const currencies = Object.entries(totals.costByCurrency);
  if (currencies.length === 0) {
    lines.push(`| _(none)_ | ${UNKNOWN} | ${UNKNOWN} | ${UNKNOWN} | ${UNKNOWN} |`);
  } else {
    for (const [currency, cost] of currencies) {
      lines.push(`| ${currency} | ${cost.reportedCost} | ${cost.estimatedCost} | ${cost.effectiveCost} | ${cost.accounting} |`);
    }
  }
  lines.push('');
  lines.push('### Requested breakdown');
  lines.push('');
  lines.push('| Group | Known effective cost | Provider runs | Input | Output | Unknown cost | Accounting |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const groupKeys = Object.keys(report.groups);
  if (groupKeys.length === 0) {
    lines.push('| _(no entries in window)_ | - | - | - | - | - | - |');
  }
  for (const key of groupKeys) {
    const group = report.groups[key];
    lines.push(`| ${key} | ${formatCost(group)} | ${group.providerRuns} | ${totalOrUnknown(group.usage.inputTokens)} | ${totalOrUnknown(group.usage.outputTokens)} | ${group.unknownCostEntries} | ${group.accounting} |`);
  }
  if (report.budget.warnings.length > 0) {
    lines.push('');
    lines.push('### Budget warnings (informative only, non-blocking)');
    for (const warning of report.budget.warnings) lines.push(`- \`${warning.type}\`: ${JSON.stringify(warning)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const [, , inputPath, outDir] = process.argv;
  if (!inputPath || !outDir) throw new Error('usage: ai-usage-export.mjs <report.json> <outDir>');
  const report = JSON.parse(await readFile(path.resolve(inputPath), 'utf8'));
  await writeFile(path.join(outDir, 'ai-usage-report.csv'), toCsv(report), 'utf8');
  await writeFile(path.join(outDir, 'ai-usage-report.html'), toHtml(report), 'utf8');
  await writeFile(path.join(outDir, 'ai-usage-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, toJobSummary(report), { flag: 'a' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
