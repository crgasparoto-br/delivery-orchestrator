import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAiUsageReport } from '../src/v2/ai-usage-ledger.mjs';
import { evaluateAiBudgetWarnings } from '../src/v2/ai-budget.mjs';
import { runAiUsageReportCli } from '../scripts/ai-usage-report.mjs';
import { toCsv, toHtml, toJobSummary } from '../scripts/ai-usage-export.mjs';
import { upsertDeliveryMetrics, DELIVERY_V2_METRICS_SCHEMA_VERSION } from '../src/v2/metrics.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function metricsRecord(overrides = {}) {
  return {
    schemaVersion: DELIVERY_V2_METRICS_SCHEMA_VERSION,
    repository: 'acme/example',
    issueNumber: 1,
    pullRequestNumber: 10,
    materialHeadSha: SHA_A,
    risk: 'fast',
    provider: 'codex',
    classifier: { version: 'v2', fingerprint: 'fp' },
    providerCalls: 1,
    attempts: { implementation: 1, audit: 0 },
    aiUsage: {},
    durationsMs: { ciQueue: 0, ciExecution: 1, audit: 0, endToEnd: 2 },
    terminalReason: 'ready-for-human-merge',
    change: { files: 1, additions: 1, deletions: 0 },
    escalated: false,
    evidenceRefs: ['github:run/1'],
    observedAtIso: '2026-09-10T00:00:00.000Z',
    providerRunLedger: [{
      runId: 9001,
      phase: 'implementation',
      provider: 'codex',
      model: 'gpt-5-codex',
      worker: 'delivery-v2-worker-codex-fast',
      usage: { turns: 1 },
      reportedCost: { amount: 1.25, currency: 'USD' },
      estimatedCost: null,
      observedAtIso: '2026-09-10T00:00:00.000Z'
    }],
    ...overrides
  };
}

test('idempotent resume/re-entry: reprocessing the same metrics file does not duplicate ledger totals', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord());
    const first = await buildAiUsageReport({ metricsFile });
    // Re-entry: same record upserted again (identical deliveryId => replaced, not duplicated).
    await upsertDeliveryMetrics(metricsFile, metricsRecord());
    const second = await buildAiUsageReport({ metricsFile });
    assert.equal(first.totals.costByCurrency.USD.effectiveCost, 1.25);
    assert.equal(second.totals.costByCurrency.USD.effectiveCost, 1.25);
    assert.equal(second.totalDeliveries, 1);
  });
});

test('remediation-loop phase produces its own cost line without affecting implementation totals', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord({
      providerRunLedger: [
        { runId: 9101, phase: 'implementation', provider: 'codex', usage: {}, reportedCost: { amount: 1, currency: 'USD' }, estimatedCost: null },
        { runId: 9102, phase: 'remediation', provider: 'codex', usage: {}, reportedCost: { amount: 0.5, currency: 'USD' }, estimatedCost: null }
      ]
    }));
    const report = await buildAiUsageReport({ metricsFile, groupBy: ['phase'] });
    assert.equal(report.groups['implementation'].costByCurrency.USD.effectiveCost, 1);
    assert.equal(report.groups['remediation'].costByCurrency.USD.effectiveCost, 0.5);
    assert.equal(report.totals.costByCurrency.USD.effectiveCost, 1.5);
  });
});

test('technical-hygiene phase without a semantic provider call contributes no cost/token line', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    // Deterministic technical-hygiene never calls a provider: it simply has no providerRunLedger
    // entry for that phase at all (never a zero-cost/zero-token row).
    await upsertDeliveryMetrics(metricsFile, metricsRecord());
    const report = await buildAiUsageReport({ metricsFile, groupBy: ['phase'] });
    assert.equal(Object.keys(report.groups).includes('technical-hygiene'), false);
  });
});

test('failed accounting (unknown provider run cost) marks the report partial, not complete', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord({
      providerRunLedger: [{ runId: 9201, phase: 'audit', provider: 'codex', usage: {}, reportedCost: null, estimatedCost: null }]
    }));
    const report = await buildAiUsageReport({ metricsFile });
    assert.equal(report.totals.accounting, 'partial');
    assert.equal(report.totals.unknownCostEntries, 1);
  });
});

test('legacy pricing snapshot change does not retroactively alter an already-recorded reported cost', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord({
      providerRunLedger: [{ runId: 9301, phase: 'implementation', provider: 'codex', usage: {}, reportedCost: { amount: 2, currency: 'USD' }, estimatedCost: null }]
    }));
    const before = await buildAiUsageReport({ metricsFile });
    // A later delivery with a different observed reported price does not rewrite the earlier one.
    await upsertDeliveryMetrics(metricsFile, metricsRecord({
      materialHeadSha: SHA_B,
      providerRunLedger: [{ runId: 9302, phase: 'implementation', provider: 'codex', usage: {}, reportedCost: { amount: 5, currency: 'USD' }, estimatedCost: null }]
    }));
    const after = await buildAiUsageReport({ metricsFile });
    assert.equal(before.totals.costByCurrency.USD.effectiveCost, 2);
    assert.equal(after.totals.costByCurrency.USD.effectiveCost, 7);
  });
});

test('CLI/JSON/CSV/HTML/Job-Summary exports agree on the same totals from the same report', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord());
    const outPath = path.join(dir, 'ai-usage-report.json');
    const payload = await runAiUsageReportCli(['--metrics-file', metricsFile, '--budget-file', path.join(dir, 'missing-budget.json'), '--out', outPath]);
    const fromDisk = JSON.parse(await readFile(outPath, 'utf8'));
    assert.deepEqual(fromDisk.totals, payload.totals);

    const csv = toCsv(payload);
    const html = toHtml(payload);
    const summary = toJobSummary(payload);
    assert.match(csv, /1\.25/);
    assert.match(html, /1\.2500/);
    assert.match(summary, /1\.2500/);
    assert.equal(payload.budget.configured, false);
  });
});

test('budget warnings are informative only and never block the report', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord({
      providerRunLedger: [{ runId: 9401, phase: 'implementation', provider: 'codex', usage: {}, reportedCost: { amount: 100, currency: 'USD' }, estimatedCost: null }]
    }));
    const report = await buildAiUsageReport({ metricsFile });
    const result = evaluateAiBudgetWarnings(report, { monthly: { amount: 10, currency: 'USD' }, warnings: { issueCost: 5 } });
    assert.equal(result.configured, true);
    assert.equal(result.blocking, false);
    assert.ok(result.warnings.some((w) => w.type === 'monthly-budget-exceeded'));
  });
});

test('CLI filters by repository/issue/pr/phase', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await upsertDeliveryMetrics(metricsFile, metricsRecord());
    await upsertDeliveryMetrics(metricsFile, metricsRecord({
      repository: 'acme/other', materialHeadSha: SHA_B, pullRequestNumber: 11,
      providerRunLedger: [{ runId: 9501, phase: 'implementation', provider: 'codex', usage: {}, reportedCost: { amount: 3, currency: 'USD' }, estimatedCost: null }]
    }));
    const filtered = await buildAiUsageReport({ metricsFile, repository: 'acme/other' });
    assert.equal(filtered.totals.costByCurrency.USD.effectiveCost, 3);
  });
});

test('writeFile smoke: export script writes csv/html/json files to disk', async () => {
  await withTempDir(async (dir) => {
    const reportPath = path.join(dir, 'report.json');
    const report = await buildAiUsageReport({ metricsFile: path.join(dir, 'nonexistent.json') });
    await writeFile(reportPath, JSON.stringify({ ...report, budget: { configured: false, warnings: [] } }));
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [path.resolve('scripts/ai-usage-export.mjs'), reportPath, dir]);
    const csv = await readFile(path.join(dir, 'ai-usage-report.csv'), 'utf8');
    assert.match(csv, /group,currency/);
  });
});
