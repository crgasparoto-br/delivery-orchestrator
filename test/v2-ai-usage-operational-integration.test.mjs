/**
 * End-to-end AI Usage & Cost Reporting integration.
 *
 * Every scenario below drives the REAL operational path:
 *   controller observability accumulator
 *     -> recordControllerProviderObservation (real provider observation contract)
 *     -> createControllerDeliveryMetrics (produces providerRunLedger, no hand-built fixture)
 *     -> persistOperationalDeliveryMetrics (canonical metrics.mjs store contract)
 *     -> npm run ai:usage CLI
 *     -> JSON / CSV / HTML / Job Summary
 *
 * No test here injects `providerRunLedger` by hand; the ledger must be produced by the
 * accumulator itself, which is what scenario O asserts explicitly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createControllerObservability,
  recordControllerProviderObservation,
  recordControllerCiObservation,
  createControllerDeliveryMetrics
} from '../src/v2/controller-observability.mjs';
import { loadAiPricingCatalog, normalizeAiPricingCatalog, estimateProviderRunCost } from '../src/v2/ai-pricing.mjs';
import { persistOperationalDeliveryMetrics, loadOperationalMetricsStore } from '../src/v2/metrics-store.mjs';
import { buildAiUsageReport } from '../src/v2/ai-usage-ledger.mjs';
import { summarizeDeliveryAiUsage, renderDeliveryAiUsageSummary } from '../src/v2/ai-usage-summary.mjs';
import { runAiUsageReportCli } from '../scripts/ai-usage-report.mjs';
import { toCsv, toHtml, toJobSummary } from '../scripts/ai-usage-export.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NO_BUDGET = 'missing-budget.json';

const ciRun = {
  id: 501,
  created_at: '2026-09-13T20:00:00.000Z',
  run_started_at: '2026-09-13T20:00:01.000Z',
  updated_at: '2026-09-13T20:00:03.000Z'
};

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-usage-integration-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pricing = await loadAiPricingCatalog(path.resolve('config/delivery-v2-ai-pricing.json'));

/** A gh-aw style usage artifact, as the controller really receives it. */
function usageArtifact({
  model = 'gpt-5-codex', engine = 'codex', inputTokens = 1000, outputTokens = 500,
  costUsd = null, startedAt = '2026-09-13T19:00:00.000Z', completedAt = '2026-09-13T19:05:00.000Z',
  cacheRead = null, turns = 2
} = {}) {
  const payload = {
    engine, model, turns,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    started_at: startedAt,
    completed_at: completedAt
  };
  if (costUsd != null) payload.total_cost_usd = costUsd;
  if (cacheRead != null) payload.cache_read_input_tokens = cacheRead;
  return payload;
}

/** Builds delivery metrics through the real accumulator; `observe` receives the state. */
function deliveryMetrics({ observe, overrides = {}, nowMs = 2000 } = {}) {
  let state = createControllerObservability({ startedAtMs: 1000 });
  state = observe(state);
  state = recordControllerCiObservation(state, { run: ciRun, evidenceRef: 'ci:501' });
  return createControllerDeliveryMetrics({
    observability: state,
    repository: 'acme/example',
    issueNumber: 213,
    pullRequestNumber: 214,
    materialHeadSha: SHA_A,
    risk: 'critical',
    provider: 'codex',
    classifier: { version: 'v2', fingerprint: 'fp' },
    attempts: { implementation: 1, audit: 1 },
    change: { files: 1, additions: 1, deletions: 0 },
    terminalReason: 'ready-for-human-merge',
    nowMs,
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// O: the controller produces the ledger, with no hand-built fixture.
// ---------------------------------------------------------------------------
test('scenario O: createControllerDeliveryMetrics produces providerRunLedger from real observations', () => {
  const metrics = deliveryMetrics({
    observe: (state) => recordControllerProviderObservation(state, {
      runId: 9001,
      stage: 'implementation',
      phase: 'implementation',
      provider: 'codex',
      role: 'implementation-worker',
      worker: 'delivery-v2-worker-codex',
      workflowRunId: 9001,
      materialHeadSha: SHA_A,
      implementationAttempt: 1,
      remediationAttempt: 0,
      terminalState: 'success',
      usage: { input_tokens: 1000, output_tokens: 500, turns: 2 },
      rawUsagePayload: usageArtifact({ costUsd: 0.42, cacheRead: 128 }),
      pricingCatalog: pricing,
      evidenceRef: 'run:9001'
    })
  });

  assert.equal(metrics.providerRunAccounting, 'complete');
  assert.equal(metrics.providerRunLedger.length, 1);
  const [run] = metrics.providerRunLedger;

  // Identity, attribution and attempts survive the accumulator.
  assert.equal(run.runId, 9001);
  assert.equal(run.workflowRunId, 9001);
  assert.equal(run.materialHeadSha, SHA_A);
  assert.equal(run.phase, 'implementation');
  assert.equal(run.provider, 'codex');
  assert.equal(run.model, 'gpt-5-codex');
  assert.equal(run.worker, 'delivery-v2-worker-codex');
  assert.equal(run.role, 'implementation-worker');
  assert.equal(run.implementationAttempt, 1);
  assert.equal(run.remediationAttempt, 0);
  assert.equal(run.terminalState, 'success');

  // Usage, cache semantics and timestamps come from the same artifact.
  assert.equal(run.usage.inputTokens, 1000);
  assert.equal(run.usage.outputTokens, 500);
  assert.equal(run.usage.totalTokens, 1500);
  assert.equal(run.usageAccounting, 'complete');
  assert.equal(run.cache.cacheReadInputTokens, 128);
  assert.equal(run.startedAtIso, '2026-09-13T19:00:00.000Z');
  assert.equal(run.endedAtIso, '2026-09-13T19:05:00.000Z');

  // Reported cost wins and no estimate is attached alongside it.
  assert.equal(run.costProvenance, 'reported');
  assert.equal(run.reportedCost.amount, 0.42);
  assert.equal(run.estimatedCost, null);
  assert.equal(run.effectiveCost.source, 'reported');
  assert.equal(run.evidenceRef, 'run:9001');
});

// ---------------------------------------------------------------------------
// A: full telemetry through store, CLI and every export format.
// ---------------------------------------------------------------------------
test('scenario A: complete telemetry flows to store, CLI, JSON, CSV, HTML and Job Summary', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 9101, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 1000, output_tokens: 500 },
        rawUsagePayload: usageArtifact({ costUsd: 1.25 }),
        pricingCatalog: pricing, evidenceRef: 'run:9101'
      })
    });

    const persisted = await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    assert.equal(persisted.persisted, true);

    const store = await loadOperationalMetricsStore(metricsFile);
    assert.equal(store.present, true);
    assert.equal(store.records.length, 1);

    const payload = await runAiUsageReportCli(
      ['--metrics-file', metricsFile, '--budget-file', path.join(dir, NO_BUDGET)],
      { log: () => {} }
    );

    assert.equal(payload.totals.providerRuns, 1);
    assert.equal(payload.totals.usage.inputTokens.total, 1000);
    assert.equal(payload.totals.usage.outputTokens.total, 500);
    assert.equal(payload.totals.costByCurrency.USD.effectiveCost, 1.25);
    assert.equal(payload.totals.unknownCostEntries, 0);
    assert.equal(payload.totals.accounting, 'complete');

    // M: every surface is rendered from this one payload and reports the same figures.
    const csv = toCsv(payload);
    const html = toHtml(payload);
    const summary = toJobSummary(payload);
    for (const rendered of [csv, html, summary]) assert.match(rendered, /1\.25/);
    assert.match(html, /Known effective cost by currency/);
    assert.match(html, /Cost per day/);
    assert.match(html, /Cost per repository/);
    assert.match(html, /Cost per phase/);
    assert.match(html, /Cost per provider/);
    assert.match(html, /Highest absolute consumption/);
    assert.match(html, /Remediations/);
    assert.match(summary, /Input tokens \| 1000/);
    assert.match(csv, /inputTokens/);
  });
});

// ---------------------------------------------------------------------------
// B: tokens known, cost unknown (unpriced model, nothing reported).
// ---------------------------------------------------------------------------
test('scenario B: tokens without cost stay unknown-cost and are never coerced to zero', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 9201, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 700, output_tokens: 300 },
        // A model that is deliberately absent from the committed pricing catalog.
        rawUsagePayload: usageArtifact({ model: 'unpriced-experimental-model', costUsd: null }),
        pricingCatalog: pricing, evidenceRef: 'run:9201'
      })
    });
    const [run] = metrics.providerRunLedger;
    assert.equal(run.costProvenance, 'unknown');
    assert.equal(run.effectiveCost, null);
    assert.equal(run.usage.totalTokens, 1000);

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({ metricsFile });
    assert.equal(report.totals.usage.totalTokens.total, 1000);
    assert.equal(report.totals.unknownCostEntries, 1);
    assert.deepEqual(report.totals.costByCurrency, {});
    assert.equal(report.totals.accounting, 'partial');

    // The unknown must survive into the exports verbatim, not as 0.
    const csv = toCsv({ ...report, budget: { warnings: [] } });
    assert.match(csv, /,unknown,unknown,unknown,unknown,/);
  });
});

// ---------------------------------------------------------------------------
// C: provider run happened, usage evidence missing.
// ---------------------------------------------------------------------------
test('scenario C: provider run with absent usage keeps usage unknown while still counting the call', async () => {
  const metrics = deliveryMetrics({
    observe: (state) => recordControllerProviderObservation(state, {
      runId: 9301, stage: 'audit', phase: 'audit', provider: 'codex',
      usage: {}, durationMs: 50, rawUsagePayload: null, pricingCatalog: pricing
    })
  });
  assert.equal(metrics.providerCalls, 1);
  const [run] = metrics.providerRunLedger;
  assert.equal(run.usageAccounting, 'unknown');
  assert.equal(run.usage.inputTokens, null);
  assert.equal(run.usage.totalTokens, null);
  assert.equal(run.effectiveCost, null);
});

// ---------------------------------------------------------------------------
// D: proven zero provider calls is NOT an unknown-cost provider run.
// ---------------------------------------------------------------------------
test('scenario D: a proven zero-provider-call delivery is not an unknown-cost provider run', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 9401, stage: 'audit', phase: 'audit', provider: 'codex',
        // The deterministic audit proved it made no provider call at all.
        usage: { providerCalls: 0 }, durationMs: 50, evidenceRef: 'run:9401'
      })
    });

    assert.equal(metrics.providerCalls, 0);
    assert.equal(metrics.providerRunLedger.length, 0);
    assert.equal(metrics.providerRunAccounting, 'complete');

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({ metricsFile });

    // The discriminating assertion: zero calls proven must NOT become unknownCostEntries=1.
    assert.equal(report.totals.unknownCostEntries, 0);
    assert.equal(report.totals.zeroProviderCallEntries, 1);
    assert.equal(report.totals.providerRuns, 0);
    assert.equal(report.totals.accounting, 'complete');
    // And no tokens or cost are fabricated for it.
    assert.equal(report.totals.usage.totalTokens.total, null);
    assert.deepEqual(report.totals.costByCurrency, {});
  });
});

test('scenario D: a zero-call delivery is distinguishable from an unknown-cost run and from legacy', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');

    // (1) proven zero calls
    await persistOperationalDeliveryMetrics(deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 9411, stage: 'audit', phase: 'audit', provider: 'codex', usage: { providerCalls: 0 }, durationMs: 1
      })
    }), { storePath: metricsFile });

    // (2) a real provider run whose cost is unknown
    await persistOperationalDeliveryMetrics(deliveryMetrics({
      overrides: { materialHeadSha: SHA_B },
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 9412, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 5, output_tokens: 5 },
        rawUsagePayload: usageArtifact({ model: 'unpriced-experimental-model' }), pricingCatalog: pricing
      })
    }), { storePath: metricsFile });

    // (3) a legacy record with no ledger at all (K)
    await persistOperationalDeliveryMetrics({
      schemaVersion: 1, repository: 'acme/legacy', issueNumber: null, pullRequestNumber: 7,
      materialHeadSha: 'c'.repeat(40), risk: 'fast', provider: 'github-actions',
      classifier: { version: 'v1', fingerprint: 'legacy' }, providerCalls: 0,
      attempts: { implementation: 1, audit: 0 }, aiUsage: {},
      providerCost: { available: false, amount: null, currency: null },
      durationsMs: { ciQueue: 0, ciExecution: 1, audit: 0, endToEnd: 2 },
      terminalReason: 'merged', change: { files: 1, additions: 1, deletions: 0 },
      escalated: false, evidenceRefs: ['github:legacy/1']
    }, { storePath: metricsFile });

    const report = await buildAiUsageReport({ metricsFile });
    assert.equal(report.totals.zeroProviderCallEntries, 1, 'proven zero calls');
    assert.equal(report.totals.unknownCostEntries, 2, 'one unknown-cost run + one legacy row');
    assert.equal(report.totals.legacyEntries, 1, 'legacy records are counted apart');
    assert.equal(report.totals.providerRuns, 1);

    const byKind = report.byDay;
    assert.ok(Object.keys(byKind).length > 0);
  });
});

// ---------------------------------------------------------------------------
// E: re-entry / idempotence.
// ---------------------------------------------------------------------------
test('scenario E: re-entry and resume never double-count a provider run already accounted', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const observe = (state) => {
      let next = recordControllerProviderObservation(state, {
        runId: 9501, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 100, output_tokens: 50 },
        rawUsagePayload: usageArtifact({ costUsd: 2 }), pricingCatalog: pricing
      });
      // The controller re-observes the same run after a resume/recovery.
      next = recordControllerProviderObservation(next, {
        runId: 9501, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 100, output_tokens: 50 },
        rawUsagePayload: usageArtifact({ costUsd: 2 }), pricingCatalog: pricing
      });
      return next;
    };

    const metrics = deliveryMetrics({ observe });
    assert.equal(metrics.providerCalls, 1);
    assert.equal(metrics.providerRunLedger.length, 1);

    // Persisting the same delivery twice must also not duplicate it in the store.
    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });

    const report = await buildAiUsageReport({ metricsFile });
    assert.equal(report.totalDeliveries, 1);
    assert.equal(report.totals.providerRuns, 1);
    assert.equal(report.totals.costByCurrency.USD.effectiveCost, 2);
  });
});

// ---------------------------------------------------------------------------
// F: audit -> remediation -> audit loop attribution.
// ---------------------------------------------------------------------------
test('scenario F: audit -> remediation -> audit attributes each run to its own phase', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => {
        let next = recordControllerProviderObservation(state, {
          runId: 9601, stage: 'audit', phase: 'audit', provider: 'codex', durationMs: 10,
          usage: { input_tokens: 10, output_tokens: 10 },
          rawUsagePayload: usageArtifact({ costUsd: 0.1 }), pricingCatalog: pricing
        });
        next = recordControllerProviderObservation(next, {
          runId: 9602, stage: 'implementation', phase: 'remediation', provider: 'codex',
          remediationAttempt: 1,
          usage: { input_tokens: 20, output_tokens: 20 },
          rawUsagePayload: usageArtifact({ costUsd: 0.2 }), pricingCatalog: pricing
        });
        return recordControllerProviderObservation(next, {
          runId: 9603, stage: 'audit', phase: 'audit', provider: 'codex', durationMs: 10,
          usage: { input_tokens: 30, output_tokens: 30 },
          rawUsagePayload: usageArtifact({ costUsd: 0.3 }), pricingCatalog: pricing
        });
      },
      overrides: { attempts: { implementation: 2, audit: 2 } }
    });

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({ metricsFile, groupBy: ['phase'] });

    assert.equal(report.totals.auditRuns, 2);
    assert.equal(report.totals.remediationRuns, 1);
    assert.equal(report.groups.audit.providerRuns, 2);
    assert.equal(report.groups.remediation.providerRuns, 1);
    // 0.1 + 0.2 + 0.3, all reported, same currency.
    assert.equal(report.totals.costByCurrency.USD.effectiveCost, 0.6);
  });
});

// ---------------------------------------------------------------------------
// G: failed run / partial accounting.
// ---------------------------------------------------------------------------
test('scenario G: a failed provider run keeps the delivery accounting honest (partial)', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => {
        const next = recordControllerProviderObservation(state, {
          runId: 9701, stage: 'implementation', phase: 'implementation', provider: 'codex',
          terminalState: 'failure',
          usage: {}, rawUsagePayload: null, pricingCatalog: pricing
        });
        return recordControllerProviderObservation(next, {
          runId: 9702, stage: 'implementation', phase: 'implementation', provider: 'codex',
          usage: { input_tokens: 10, output_tokens: 10 },
          rawUsagePayload: usageArtifact({ costUsd: 1 }), pricingCatalog: pricing
        });
      }
    });

    const failed = metrics.providerRunLedger.find((run) => run.runId === 9701);
    assert.equal(failed.terminalState, 'failure');
    assert.equal(failed.usageAccounting, 'unknown');

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({ metricsFile });
    assert.equal(report.totals.unknownCostEntries, 1);
    assert.equal(report.totals.accounting, 'partial');

    const summary = summarizeDeliveryAiUsage(metrics);
    assert.equal(summary.accounting, 'partial');
    assert.match(renderDeliveryAiUsageSummary(summary), /Accounting {7}partial/);
  });
});

// ---------------------------------------------------------------------------
// H: two currencies are never summed.
// ---------------------------------------------------------------------------
test('scenario H: two currencies are reported side by side and never summed or converted', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => {
        const next = recordControllerProviderObservation(state, {
          runId: 9801, stage: 'implementation', phase: 'implementation', provider: 'codex',
          reportedCost: { amount: 3, currency: 'USD' },
          usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
        });
        return recordControllerProviderObservation(next, {
          runId: 9802, stage: 'implementation', phase: 'implementation', provider: 'codex',
          reportedCost: { amount: 5, currency: 'EUR' },
          usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
        });
      }
    });

    // A delivery mixing currencies cannot be collapsed into one scalar providerCost.
    assert.equal(metrics.providerCost.available, false);

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({ metricsFile });
    assert.equal(report.totals.costByCurrency.USD.effectiveCost, 3);
    assert.equal(report.totals.costByCurrency.EUR.effectiveCost, 5);
    assert.equal(Object.keys(report.totals.costByCurrency).length, 2);

    const html = toHtml({ ...report, budget: { warnings: [] } });
    assert.match(html, /USD/);
    assert.match(html, /EUR/);
  });
});

// ---------------------------------------------------------------------------
// I: reported + estimated in the same window, never summed for the same run.
// ---------------------------------------------------------------------------
test('scenario I: reported and estimated coexist per window but never for the same run', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => {
        // Reported: the estimate must not be computed at all.
        const next = recordControllerProviderObservation(state, {
          runId: 9901, stage: 'implementation', phase: 'implementation', provider: 'codex',
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
          rawUsagePayload: usageArtifact({ model: 'gpt-5-codex', costUsd: 0.01 }),
          pricingCatalog: pricing
        });
        // Not reported, but priced: the estimate is derived from the committed catalog.
        return recordControllerProviderObservation(next, {
          runId: 9902, stage: 'implementation', phase: 'implementation', provider: 'codex',
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
          rawUsagePayload: usageArtifact({ model: 'gpt-5-codex', costUsd: null }),
          pricingCatalog: pricing
        });
      }
    });

    const reported = metrics.providerRunLedger.find((run) => run.runId === 9901);
    const estimated = metrics.providerRunLedger.find((run) => run.runId === 9902);

    assert.equal(reported.costProvenance, 'reported');
    assert.equal(reported.reportedCost.amount, 0.01);
    assert.equal(reported.estimatedCost, null, 'reported runs never also carry an estimate');
    assert.equal(reported.pricingSnapshot, null);

    assert.equal(estimated.costProvenance, 'estimated');
    assert.equal(estimated.reportedCost, null);
    assert.equal(estimated.estimatedCost.amount, 1.25, '1M input tokens at 1.25/M');
    assert.equal(estimated.pricingSnapshot.version, pricing.pricingVersion);

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({ metricsFile });
    const usd = report.totals.costByCurrency.USD;
    assert.equal(usd.reportedCost, 0.01);
    assert.equal(usd.estimatedCost, 1.25);
    // Effective is the sum of each run's own precedence-resolved cost, not reported+estimated
    // of the same run.
    assert.equal(usd.effectiveCost, 1.26);
    assert.equal(usd.accounting, 'partial');
  });
});

// ---------------------------------------------------------------------------
// J: a pricing change must not rewrite an already-recorded historical estimate.
// ---------------------------------------------------------------------------
test('scenario J: changing pricing preserves the historical snapshot and cost of an old run', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');

    const oldMetrics = deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 10001, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
        rawUsagePayload: usageArtifact({ model: 'gpt-5-codex', costUsd: null }),
        pricingCatalog: pricing
      })
    });
    await persistOperationalDeliveryMetrics(oldMetrics, { storePath: metricsFile });

    const before = await buildAiUsageReport({ metricsFile });
    assert.equal(before.totals.costByCurrency.USD.effectiveCost, 1.25);

    // Pricing is revised upward in a new catalog version.
    const revised = normalizeAiPricingCatalog({
      schemaVersion: 1,
      pricingVersion: '2027-01-01',
      models: { 'codex/gpt-5-codex': { currency: 'USD', inputPerMillionTokens: 99, outputPerMillionTokens: 99 } }
    });
    assert.equal(
      estimateProviderRunCost({ provider: 'codex', model: 'gpt-5-codex', usage: { inputTokens: 1_000_000, outputTokens: 0 } }, revised).amount,
      99,
      'a NEW run under the revised catalog is priced with the new rates'
    );

    // The already-recorded historical run is untouched: same snapshot, same cost.
    const after = await buildAiUsageReport({ metricsFile });
    assert.equal(after.totals.costByCurrency.USD.effectiveCost, 1.25);
    const [historical] = (await loadOperationalMetricsStore(metricsFile)).records[0].providerRunLedger;
    assert.equal(historical.pricingSnapshot.version, '2026-09-01');
    assert.equal(historical.pricingSnapshot.inputPerMillionTokens, 1.25);
    assert.equal(historical.estimatedCost.amount, 1.25);
  });
});

// ---------------------------------------------------------------------------
// L: temporal boundaries.
// ---------------------------------------------------------------------------
test('scenario L: period filtering uses real instants and the run terminal timestamp', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => {
        // Starts before the window, terminates inside it.
        let next = recordControllerProviderObservation(state, {
          runId: 11001, stage: 'implementation', phase: 'implementation', provider: 'codex',
          startedAtIso: '2026-08-31T23:00:00Z', endedAtIso: '2026-09-01T01:00:00Z',
          usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
        });
        // Terminates exactly on the closing boundary, expressed with a +00:00 offset.
        next = recordControllerProviderObservation(next, {
          runId: 11002, stage: 'implementation', phase: 'implementation', provider: 'codex',
          endedAtIso: '2026-09-30T23:59:59.999+00:00',
          usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
        });
        // Terminates after the window.
        next = recordControllerProviderObservation(next, {
          runId: 11003, stage: 'implementation', phase: 'implementation', provider: 'codex',
          endedAtIso: '2026-10-01T00:00:00Z',
          usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
        });
        // Terminal timestamp entirely unknown: must NOT be silently pulled into the window.
        return recordControllerProviderObservation(next, {
          runId: 11004, stage: 'implementation', phase: 'implementation', provider: 'codex',
          usage: { input_tokens: 1, output_tokens: 1 }, rawUsagePayload: null, pricingCatalog: pricing
        });
      }
    });

    const unknownRun = metrics.providerRunLedger.find((run) => run.runId === 11004);
    assert.equal(unknownRun.endedAtIso, null, 'unknown terminal timestamp stays unknown');

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const report = await buildAiUsageReport({
      metricsFile, from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59.999Z'
    });

    assert.deepEqual(
      report.entries.map((entry) => entry.runId).sort((a, b) => a - b),
      [11001, 11002],
      'run starting before but ending inside, and run ending exactly on the boundary'
    );
    assert.equal(report.unknownTerminalTimestampEntries, 1);
  });
});

test('scenario L: equivalent offsets resolve to the same instant', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 11101, stage: 'implementation', phase: 'implementation', provider: 'codex',
        endedAtIso: '2026-09-15T12:00:00Z',
        usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
      })
    });
    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });

    const withZ = await buildAiUsageReport({ metricsFile, from: '2026-09-15T00:00:00Z', to: '2026-09-15T23:59:59Z' });
    const withOffset = await buildAiUsageReport({ metricsFile, from: '2026-09-15T00:00:00+00:00', to: '2026-09-15T23:59:59+00:00' });
    assert.equal(withZ.totals.entriesCount, 1);
    assert.deepEqual(withOffset.totals, withZ.totals);
  });
});

test('scenario L: an inverted interval is rejected instead of silently returning nothing', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await persistOperationalDeliveryMetrics(deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 11201, stage: 'implementation', phase: 'implementation', provider: 'codex',
        endedAtIso: '2026-09-15T12:00:00Z', usage: {}, pricingCatalog: pricing
      })
    }), { storePath: metricsFile });

    await assert.rejects(
      () => buildAiUsageReport({ metricsFile, from: '2026-09-30T00:00:00Z', to: '2026-09-01T00:00:00Z' }),
      /must not precede/
    );
    await assert.rejects(
      () => buildAiUsageReport({ metricsFile, from: 'not-a-date', to: '2026-09-01T00:00:00Z' }),
      /valid ISO-8601 instant/
    );
  });
});

test('scenario L: an explicit fixed timezone offset shifts day boundaries deterministically', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await persistOperationalDeliveryMetrics(deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 11301, stage: 'implementation', phase: 'implementation', provider: 'codex',
        // 01:00 UTC on the 16th is still the 15th in -03:00.
        endedAtIso: '2026-09-16T01:00:00Z', usage: {}, pricingCatalog: pricing
      })
    }), { storePath: metricsFile });

    const nowMs = Date.parse('2026-09-16T02:00:00Z');
    const utcToday = await buildAiUsageReport({ metricsFile, period: 'today', timezone: 'UTC', nowMs });
    const offsetToday = await buildAiUsageReport({ metricsFile, period: 'today', timezone: '-03:00', nowMs });

    assert.equal(utcToday.period.timezone, 'UTC');
    assert.equal(offsetToday.period.timezone, '-03:00');
    assert.notEqual(offsetToday.period.from, utcToday.period.from);
    // Both windows still contain the run, but their boundaries differ by the offset.
    assert.equal(utcToday.totals.entriesCount, 1);
    assert.equal(offsetToday.totals.entriesCount, 1);

    await assert.rejects(
      () => buildAiUsageReport({ metricsFile, period: 'today', timezone: 'America/Sao_Paulo' }),
      /unsupported timezone/
    );
  });
});

// ---------------------------------------------------------------------------
// N: remediationCount warning.
// ---------------------------------------------------------------------------
test('scenario N: remediationCount threshold produces an informative, non-blocking warning', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const metrics = deliveryMetrics({
      observe: (state) => {
        let next = state;
        for (let index = 0; index < 3; index += 1) {
          next = recordControllerProviderObservation(next, {
            runId: 12001 + index, stage: 'implementation', phase: 'remediation', provider: 'codex',
            remediationAttempt: index + 1,
            usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
          });
        }
        return next;
      },
      overrides: { attempts: { implementation: 4, audit: 1 } }
    });
    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });

    const budgetFile = path.join(dir, 'budget.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(budgetFile, JSON.stringify({ schemaVersion: 1, warnings: { remediationCount: 2 } }));

    const payload = await runAiUsageReportCli(
      ['--metrics-file', metricsFile, '--budget-file', budgetFile, '--group-by', 'phase'],
      { log: () => {} }
    );

    assert.equal(payload.totals.remediationRuns, 3);
    const warning = payload.budget.warnings.find((item) => item.type === 'remediation-count-warning' && item.scope === 'total');
    assert.ok(warning, 'a remediation-count warning is emitted above the threshold');
    assert.equal(warning.remediationRuns, 3);
    assert.equal(warning.limit, 2);
    // Informative only: it never blocks.
    assert.equal(payload.budget.blocking, false);

    const summary = toJobSummary(payload);
    assert.match(summary, /remediation-count-warning/);
  });
});

test('scenario N: remediation volume below the threshold produces no warning', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await persistOperationalDeliveryMetrics(deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 12101, stage: 'implementation', phase: 'remediation', provider: 'codex',
        usage: { input_tokens: 1, output_tokens: 1 }, pricingCatalog: pricing
      })
    }), { storePath: metricsFile });

    const budgetFile = path.join(dir, 'budget.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(budgetFile, JSON.stringify({ schemaVersion: 1, warnings: { remediationCount: 5 } }));

    const payload = await runAiUsageReportCli(
      ['--metrics-file', metricsFile, '--budget-file', budgetFile],
      { log: () => {} }
    );
    assert.equal(payload.budget.warnings.filter((item) => item.type === 'remediation-count-warning').length, 0);
  });
});

// ---------------------------------------------------------------------------
// P: a missing operational store must fail loudly, not report an empty window.
// ---------------------------------------------------------------------------
test('scenario P: a missing operational store fails loudly instead of reporting an empty window', async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, 'does-not-exist.json');
    await assert.rejects(
      () => buildAiUsageReport({ metricsFile: missing }),
      /operational Delivery V2 metrics store not found/
    );
    await assert.rejects(
      () => runAiUsageReportCli(['--metrics-file', missing], { log: () => {} }),
      /operational Delivery V2 metrics store not found/
    );

    // The empty-window case stays available, but only when asked for explicitly.
    const report = await buildAiUsageReport({ metricsFile: missing, allowMissingStore: true });
    assert.equal(report.storePresent, false);
    assert.equal(report.totalDeliveries, 0);
  });
});

test('the committed operational store is the default source and is readable out of the box', async () => {
  // `npm run ai:usage` must work without anyone hand-assembling a metrics file.
  const payload = await runAiUsageReportCli([], { log: () => {} });
  assert.equal(payload.storePresent, true);
  assert.match(payload.storePath, /docs\/delivery-v2\/evidence\/delivery-v2-metrics\.json$/);
});

// ---------------------------------------------------------------------------
// M: CLI human output agrees with the shared payload.
// ---------------------------------------------------------------------------
test('scenario M: CLI human output reports the same figures as JSON/CSV/HTML/Job Summary', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    await persistOperationalDeliveryMetrics(deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 13001, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 4242, output_tokens: 2121 },
        rawUsagePayload: usageArtifact({ costUsd: 7.5 }), pricingCatalog: pricing
      })
    }), { storePath: metricsFile });

    const lines = [];
    const payload = await runAiUsageReportCli(
      ['--metrics-file', metricsFile, '--budget-file', path.join(dir, NO_BUDGET)],
      { log: (line) => lines.push(line) }
    );
    const printed = lines.join('\n');

    // Every figure the issue requires from the human output.
    assert.match(printed, /period:/);
    assert.match(printed, /timezone:\s+UTC/);
    assert.match(printed, /provider runs:\s+1/);
    assert.match(printed, /input tokens:\s+4242/);
    assert.match(printed, /output tokens:\s+2121/);
    assert.match(printed, /total tokens:\s+6363/);
    assert.match(printed, /known cost\[USD\]:\s+effective=7\.5/);
    assert.match(printed, /unknown cost runs:\s+0/);
    assert.match(printed, /unknown usage:/);
    assert.match(printed, /breakdown:/);

    // And the other surfaces carry the same numbers from the same payload.
    for (const rendered of [toCsv(payload), toHtml(payload), toJobSummary(payload)]) {
      assert.match(rendered, /4242/);
      assert.match(rendered, /7\.5/);
    }
  });
});

// ---------------------------------------------------------------------------
// Delivery-closing AI usage summary.
// ---------------------------------------------------------------------------
test('delivery closing summary reports per-phase usage and never claims false completeness', () => {
  const metrics = deliveryMetrics({
    observe: (state) => {
      const next = recordControllerProviderObservation(state, {
        runId: 14001, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 100, output_tokens: 40 },
        rawUsagePayload: usageArtifact({ costUsd: 1 }), pricingCatalog: pricing
      });
      return recordControllerProviderObservation(next, {
        runId: 14002, stage: 'audit', phase: 'audit', provider: 'codex', durationMs: 5,
        usage: { input_tokens: 10, output_tokens: 5 },
        rawUsagePayload: usageArtifact({ costUsd: 0.5 }), pricingCatalog: pricing
      });
    }
  });

  const summary = summarizeDeliveryAiUsage(metrics);
  assert.equal(summary.accounting, 'complete');
  assert.equal(summary.aiCalls, 2);
  assert.equal(summary.inputTokens, 110);
  assert.equal(summary.outputTokens, 45);
  assert.deepEqual(summary.knownCostByCurrency, { USD: 1.5 });
  assert.equal(summary.unknownCostRuns, 0);

  const rendered = renderDeliveryAiUsageSummary(summary);
  assert.match(rendered, /## AI usage/);
  assert.match(rendered, /Implementation/);
  assert.match(rendered, /Audit/);
  assert.match(rendered, /Known cost {7}USD 1\.5/);
  assert.match(rendered, /Unknown cost runs 0/);
  assert.match(rendered, /Accounting {7}complete/);
  assert.match(rendered, /Input tokens {5}110/);
  assert.match(rendered, /AI calls {9}2/);
});

// ---------------------------------------------------------------------------
// 13: no secret ever reaches the ledger or any export.
// ---------------------------------------------------------------------------
test('security: credentials present in a usage artifact never reach the ledger or any export', async () => {
  await withTempDir(async (dir) => {
    const metricsFile = path.join(dir, 'metrics.json');
    const secret = 'ghp_SUPERSECRETTOKENVALUE0000000000000000';
    const metrics = deliveryMetrics({
      observe: (state) => recordControllerProviderObservation(state, {
        runId: 15001, stage: 'implementation', phase: 'implementation', provider: 'codex',
        usage: { input_tokens: 10, output_tokens: 10 },
        rawUsagePayload: {
          ...usageArtifact({ costUsd: 1 }),
          // Fields a real artifact might carry; the fail-closed allowlist must drop them all.
          api_key: secret,
          authorization: `Bearer ${secret}`,
          env: { GITHUB_TOKEN: secret, ANTHROPIC_API_KEY: secret }
        },
        pricingCatalog: pricing
      })
    });

    const serializedLedger = JSON.stringify(metrics.providerRunLedger);
    assert.ok(!serializedLedger.includes(secret), 'ledger must not carry credentials');
    assert.ok(!serializedLedger.includes('api_key'));

    await persistOperationalDeliveryMetrics(metrics, { storePath: metricsFile });
    const stored = await readFile(metricsFile, 'utf8');
    assert.ok(!stored.includes(secret), 'persisted store must not carry credentials');

    const payload = await runAiUsageReportCli(
      ['--metrics-file', metricsFile, '--budget-file', path.join(dir, NO_BUDGET)],
      { log: () => {} }
    );
    for (const rendered of [JSON.stringify(payload), toCsv(payload), toHtml(payload), toJobSummary(payload)]) {
      assert.ok(!rendered.includes(secret), 'no export may carry credentials');
    }
  });
});

test('security: the ledger schema is a fail-closed allowlist', async () => {
  const { createDeliveryMetrics } = await import('../src/v2/metrics.mjs');
  const base = {
    repository: 'acme/example', issueNumber: 213, pullRequestNumber: 214, materialHeadSha: SHA_A,
    risk: 'critical', provider: 'codex', classifier: { version: 'v2', fingerprint: 'fp' },
    providerCalls: 1, attempts: { implementation: 1, audit: 1 }, aiUsage: {},
    durationsMs: { ciQueue: 0, ciExecution: 1, audit: 0, endToEnd: 2 },
    terminalReason: 'ready-for-human-merge', change: { files: 1, additions: 1, deletions: 0 },
    escalated: false, evidenceRefs: ['github:run/1']
  };
  // An unexpected field must be refused rather than silently carried into the ledger, which is
  // what keeps credentials out of it by construction.
  assert.throws(
    () => createDeliveryMetrics({
      ...base,
      providerRunLedger: [{ runId: 1, phase: 'implementation', provider: 'codex', usage: {}, apiKey: 'nope' }]
    }),
    /unsupported field: apiKey/
  );
  // An estimate with no pricing snapshot is also refused: an estimate must always be traceable
  // to the exact committed pricing that produced it.
  assert.throws(
    () => createDeliveryMetrics({
      ...base,
      providerRunLedger: [{
        runId: 1, phase: 'implementation', provider: 'codex', usage: {},
        reportedCost: null, estimatedCost: { amount: 1, currency: 'USD' }
      }]
    }),
    /requires a pricingSnapshot/
  );
});
