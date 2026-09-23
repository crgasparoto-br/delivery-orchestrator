#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { buildAiUsageReport } from '../src/v2/ai-usage-ledger.mjs';
import { evaluateAiBudgetWarnings } from '../src/v2/ai-budget.mjs';

const DEFAULT_METRICS_FILE = 'docs/delivery-v2/evidence/delivery-v2-metrics.json';
const DEFAULT_BUDGET_FILE = 'config/delivery-v2-ai-budget.json';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--today': out.today = true; break;
      case '--month': out.month = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; break;
      case '--from': out.from = argv[++i]; break;
      case '--to': out.to = argv[++i]; break;
      case '--repo': out.repository = argv[++i]; break;
      case '--issue': out.issueNumber = Number(argv[++i]); break;
      case '--pr': out.pullRequestNumber = Number(argv[++i]); break;
      case '--phase': out.phase = argv[++i]; break;
      case '--group-by': out.groupBy = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--metrics-file': out.metricsFile = argv[++i]; break;
      case '--budget-file': out.budgetFile = argv[++i]; break;
      case '--json': out.json = true; break;
      case '--out': out.out = argv[++i]; break;
      default: throw new Error(`unknown argument: ${arg}`);
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

export async function runAiUsageReportCli(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const metricsFile = path.resolve(cwd, args.metricsFile ?? process.env.DELIVERY_V2_METRICS_FILE ?? DEFAULT_METRICS_FILE);
  const report = await buildAiUsageReport({
    metricsFile,
    today: args.today ?? false,
    month: args.month ?? null,
    from: args.from ?? null,
    to: args.to ?? null,
    repository: args.repository ?? null,
    issueNumber: Number.isFinite(args.issueNumber) ? args.issueNumber : null,
    pullRequestNumber: Number.isFinite(args.pullRequestNumber) ? args.pullRequestNumber : null,
    phase: args.phase ?? null,
    groupBy: args.groupBy ?? ['repository', 'phase']
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
    printHumanSummary(payload);
  }
  return payload;
}

function printHumanSummary(payload) {
  console.log(`AI Usage Report [${payload.period.from ?? 'all-time'} .. ${payload.period.to ?? 'now'}] accounting=${payload.totals.accounting}`);
  console.log(`  deliveries observed: ${payload.totalDeliveries}, ledger entries in window: ${payload.totals.entriesCount}, unknown-cost entries: ${payload.totals.unknownCostEntries}`);
  const currencies = Object.keys(payload.totals.costByCurrency);
  if (currencies.length === 0) {
    console.log('  cost: no known cost in window (unknown)');
  }
  for (const currency of currencies) {
    const cost = payload.totals.costByCurrency[currency];
    console.log(`  cost[${currency}]: reported=${cost.reportedCost.toFixed(4)} estimated=${cost.estimatedCost.toFixed(4)} effective=${cost.effectiveCost.toFixed(4)} (${cost.accounting})`);
  }
  if (payload.budget.warnings.length > 0) {
    console.log('  budget warnings (informative only):');
    for (const warning of payload.budget.warnings) console.log(`   - ${warning.type}: ${JSON.stringify(warning)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runAiUsageReportCli(process.argv.slice(2));
}
