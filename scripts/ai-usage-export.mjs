#!/usr/bin/env node
// Renders CSV/HTML/Job Summary views from a single ai-usage-report.mjs JSON payload, so every
// exported artifact agrees on totals by construction (no separate aggregation logic).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(report) {
  const rows = [['group', 'currency', 'reportedCost', 'estimatedCost', 'effectiveCost', 'accounting', 'entries', 'unknownCostEntries']];
  const groupKeys = Object.keys(report.groups);
  for (const key of groupKeys) {
    const group = report.groups[key];
    const currencies = Object.keys(group.costByCurrency);
    if (currencies.length === 0) {
      rows.push([key, '', '', '', '', 'unknown', group.entriesCount, group.unknownCostEntries]);
      continue;
    }
    for (const currency of currencies) {
      const cost = group.costByCurrency[currency];
      rows.push([key, currency, cost.reportedCost, cost.estimatedCost, cost.effectiveCost, cost.accounting, group.entriesCount, group.unknownCostEntries]);
    }
  }
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function renderGroupRows(report) {
  const rows = [];
  for (const [key, group] of Object.entries(report.groups)) {
    const currencies = Object.keys(group.costByCurrency);
    if (currencies.length === 0) {
      rows.push(`<tr><td>${escapeHtml(key)}</td><td colspan="5">no known cost (${group.entriesCount} entries, unknown)</td></tr>`);
      continue;
    }
    for (const currency of currencies) {
      const cost = group.costByCurrency[currency];
      rows.push(`<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(currency)}</td><td>${cost.reportedCost.toFixed(4)}</td><td>${cost.estimatedCost.toFixed(4)}</td><td>${cost.effectiveCost.toFixed(4)}</td><td>${cost.accounting}</td></tr>`);
    }
  }
  return rows.join('\n');
}

export function toHtml(report) {
  const overallCurrencies = Object.entries(report.totals.costByCurrency)
    .map(([currency, cost]) => `${currency}: reported=${cost.reportedCost.toFixed(4)} estimated=${cost.estimatedCost.toFixed(4)} effective=${cost.effectiveCost.toFixed(4)} (${cost.accounting})`)
    .join('; ') || 'no known cost in window (unknown)';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AI Usage Report</title></head>
<body>
<h1>AI Usage &amp; Cost Report</h1>
<p>Period: ${escapeHtml(report.period.from ?? 'all-time')} .. ${escapeHtml(report.period.to ?? 'now')} (${escapeHtml(report.period.timezone)})</p>
<p>Generated: ${escapeHtml(report.generatedAtIso)}</p>
<p>Overall accounting: <strong>${report.totals.accounting}</strong> &mdash; deliveries observed: ${report.totalDeliveries}, ledger entries in window: ${report.totals.entriesCount}, unknown-cost entries: ${report.totals.unknownCostEntries}</p>
<p>${escapeHtml(overallCurrencies)}</p>
<table border="1" cellpadding="4" cellspacing="0">
<thead><tr><th>Group</th><th>Currency</th><th>Reported</th><th>Estimated</th><th>Effective</th><th>Accounting</th></tr></thead>
<tbody>
${renderGroupRows(report)}
</tbody>
</table>
${report.budget.warnings.length > 0
    ? `<h2>Budget warnings (informative only)</h2><ul>${report.budget.warnings.map((warning) => `<li>${escapeHtml(warning.type)}: ${escapeHtml(JSON.stringify(warning))}</li>`).join('')}</ul>`
    : ''}
</body>
</html>
`;
}

export function toJobSummary(report) {
  const lines = [];
  lines.push('## AI Usage & Cost Report');
  lines.push('');
  lines.push(`Period: \`${report.period.from ?? 'all-time'}\` .. \`${report.period.to ?? 'now'}\` (${report.period.timezone})`);
  lines.push('');
  lines.push(`Overall accounting: **${report.totals.accounting}** — deliveries observed: ${report.totalDeliveries}, ledger entries in window: ${report.totals.entriesCount}, unknown-cost entries: ${report.totals.unknownCostEntries}`);
  lines.push('');
  lines.push('| Currency | Reported | Estimated | Effective | Accounting |');
  lines.push('| --- | --- | --- | --- | --- |');
  const currencies = Object.entries(report.totals.costByCurrency);
  if (currencies.length === 0) {
    lines.push('| _(none)_ | - | - | - | unknown |');
  } else {
    for (const [currency, cost] of currencies) {
      lines.push(`| ${currency} | ${cost.reportedCost.toFixed(4)} | ${cost.estimatedCost.toFixed(4)} | ${cost.effectiveCost.toFixed(4)} | ${cost.accounting} |`);
    }
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
