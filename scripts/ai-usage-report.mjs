#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { buildAiUsageReport, GROUP_BY_DIMENSIONS } from '../src/v2/ai-usage-ledger.mjs';
import { evaluateAiBudgetWarnings } from '../src/v2/ai-budget.mjs';
import { resolveOperationalMetricsStorePath } from '../src/v2/metrics-store.mjs';

const DEFAULT_BUDGET_FILE = 'config/delivery-v2-ai-budget.json';
const PERIODS = new Set(['all', 'today', '7d', 'month', 'custom']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--period': out.period = argv[++i]; break;
      case '--today': out.period = 'today'; break;
      case '--7d': out.period = '7d'; break;
      case '--month': out.month = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out.period = 'month'; break;
      case '--from': out.from = argv[++i]; break;
      case '--to': out.to = argv[++i]; break;
      case '--timezone': out.timezone = argv[++i]; break;
      case '--repo': out.repository = argv[++i]; break;
      case '--issue': out.issueNumber = Number(argv[++i]); break;
      case '--pr': out.pullRequestNumber = Number(argv[++i]); break;
      case '--phase': out.phase = argv[++i]; break;
      case '--provider': out.provider = argv[++i]; break;
      case '--model': out.model = argv[++i]; break;
      case '--group-by': out.groupBy = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--metrics-file': out.metricsFile = argv[++i]; break;
      case '--budget-file': out.budgetFile = argv[++i]; break;
      case '--allow-missing-store': out.allowMissingStore = true; break;
      case '--json': out.json = true; break;
      case '--out': out.out = argv[++i]; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (out.period != null && !PERIODS.has(out.period)) {
    throw new Error(`unsupported --period: ${out.period} (expected ${[...PERIODS].join('|')})`);
  }
  for (const dimension of out.groupBy ?? []) {
    if (!GROUP_BY_DIMENSIONS[dimension]) {
      throw new Error(`unsupported --group-by dimension: ${dimension} (expected ${Object.keys(GROUP_BY_DIMENSIONS).join('|')})`);
    }
  }
  return out;
}

async function loadBudgetConfig(budgetFile) {
  try {
    return JSON.parse(await readFile(path.resolve(budgetFile), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function runAiUsageReportCli(argv, { cwd = process.cwd(), env = process.env, log = console.log } = {}) {
  const args = parseArgs(argv);
  const metricsFile = args.metricsFile
    ? path.resolve(cwd, args.metricsFile)
    : resolveOperationalMetricsStorePath({ cwd, env });

  const report = await buildAiUsageReport({
    metricsFile,
    // `all` means no bounded window; every other period resolves to real instants.
    period: args.period === 'all' ? null : (args.period ?? null),
    month: args.month ?? null,
    from: args.from ?? null,
    to: args.to ?? null,
    timezone: args.timezone ?? 'UTC',
    repository: args.repository ?? null,
    issueNumber: Number.isFinite(args.issueNumber) ? args.issueNumber : null,
    pullRequestNumber: Number.isFinite(args.pullRequestNumber) ? args.pullRequestNumber : null,
    phase: args.phase ?? null,
    provider: args.provider ?? null,
    model: args.model ?? null,
    groupBy: args.groupBy ?? ['repository', 'phase'],
    allowMissingStore: args.allowMissingStore === true
  });

  const budgetConfig = await loadBudgetConfig(path.resolve(cwd, args.budgetFile ?? DEFAULT_BUDGET_FILE));
  const budget = evaluateAiBudgetWarnings(report, budgetConfig);

  const payload = { ...report, budget };
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  if (args.out) {
    await writeFile(path.resolve(cwd, args.out), body, 'utf8');
  }
  if (args.json && !args.out) {
    process.stdout.write(body);
  } else if (!args.json && !args.out) {
    printHumanSummary(payload, log);
  }
  return payload;
}

function formatTotal(summary) {
  // `unknown` is preserved verbatim: an absent total is never rendered as 0.
  return summary.total == null ? 'unknown' : String(summary.total);
}

export function printHumanSummary(payload, log = console.log) {
  const { period, totals } = payload;
  log('AI Usage & Cost Report');
  log(`  period:            ${period.from ?? 'all-time'} .. ${period.to ?? 'now'}`);
  log(`  timezone:          ${period.timezone}`);
  log(`  store:             ${payload.storePath}`);
  log(`  deliveries:        ${totals.deliveries} in window (${payload.totalDeliveries} in store)`);
  log(`  provider runs:     ${totals.providerRuns}`);
  log(`  ledger entries:    ${totals.entriesCount}`);
  log(`  input tokens:      ${formatTotal(totals.usage.inputTokens)}`);
  log(`  output tokens:     ${formatTotal(totals.usage.outputTokens)}`);
  log(`  total tokens:      ${formatTotal(totals.usage.totalTokens)}`);
  log(`  credits:           ${formatTotal(totals.usage.credits)}`);
  log(`  accounting:        ${totals.accounting}`);

  const currencies = Object.entries(totals.costByCurrency);
  if (currencies.length === 0) {
    log('  known cost:        unknown (no known cost in window)');
  } else {
    // Currencies are listed side by side, never summed and never converted.
    for (const [currency, cost] of currencies) {
      log(`  known cost[${currency}]:  effective=${cost.effectiveCost} (reported=${cost.reportedCost} estimated=${cost.estimatedCost}, ${cost.accounting})`);
    }
  }
  log(`  unknown cost runs: ${totals.unknownCostEntries}`);
  log(`  unknown usage:     ${totals.unknownUsageEntries} unknown, ${totals.partialUsageEntries} partial`);
  log(`  zero-call entries: ${totals.zeroProviderCallEntries}`);
  log(`  legacy entries:    ${totals.legacyEntries}`);
  log(`  remediation runs:  ${totals.remediationRuns}`);
  log(`  audit runs:        ${totals.auditRuns}`);
  if (payload.unknownTerminalTimestampEntries > 0) {
    log(`  excluded (unknown terminal timestamp): ${payload.unknownTerminalTimestampEntries}`);
  }

  log('');
  log('  breakdown:');
  const groupKeys = Object.keys(payload.groups);
  if (groupKeys.length === 0) log('    (no entries in window)');
  for (const key of groupKeys) {
    const group = payload.groups[key];
    const cost = Object.entries(group.costByCurrency)
      .map(([currency, value]) => `${currency} ${value.effectiveCost}`)
      .join(' + ') || 'unknown';
    log(`    ${key}: runs=${group.providerRuns} calls=${group.entriesCount} in=${formatTotal(group.usage.inputTokens)} out=${formatTotal(group.usage.outputTokens)} cost=${cost} unknownCost=${group.unknownCostEntries} (${group.accounting})`);
  }

  if (payload.budget.warnings.length > 0) {
    log('');
    log('  budget warnings (informative only, never blocking):');
    for (const warning of payload.budget.warnings) log(`    - ${warning.type}: ${JSON.stringify(warning)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runAiUsageReportCli(process.argv.slice(2));
}
