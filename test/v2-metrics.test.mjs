import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareAgainstBaseline,
  createDeliveryMetrics,
  loadDeliveryMetricsStore,
  summarizeDeliveryMetrics,
  upsertDeliveryMetrics
} from '../src/v2/metrics.mjs';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function metricsInput(overrides = {}) {
  return {
    repository: 'acme/example',
    issueNumber: 41,
    pullRequestNumber: 42,
    materialHeadSha: SHA_A,
    risk: 'fast',
    provider: 'codex',
    classifier: { version: 'v2', fingerprint: 'fp-1' },
    providerCalls: 1,
    attempts: { implementation: 1, audit: 0 },
    aiUsage: { turns: 2, credits: 1.5, inputTokens: 100, outputTokens: 50 },
    providerCost: { amount: 0.12, currency: 'usd' },
    durationsMs: { ciQueue: 1000, ciExecution: 30000, audit: 0, endToEnd: 45000 },
    terminalReason: 'ready-for-human-merge',
    change: { files: 2, additions: 10, deletions: 4 },
    escalated: false,
    evidenceRefs: ['github:run/1'],
    ...overrides
  };
}

test('normalizes all required delivery metrics and derives safe totals', () => {
  const record = createDeliveryMetrics(metricsInput());
  assert.equal(record.deliveryId, `acme/example#42@${SHA_A}`);
  assert.equal(record.aiUsage.totalTokens, 150);
  assert.equal(record.providerCost.currency, 'USD');
  assert.equal(record.change.linesChanged, 14);
  assert.equal(record.durationsMs.endToEnd, 45000);
  assert.deepEqual(record.aiUsageByStage, {});
});

test('provider cost contract rejects extra fields that could carry provider-sensitive secrets', () => {
  assert.throws(() => createDeliveryMetrics(metricsInput({
    providerCost: { amount: 0.12, currency: 'USD', apiKey: 'secret' }
  })), /unsupported field/);
});

test('metrics allow unavailable token and cost values without inventing zeros', () => {
  const record = createDeliveryMetrics(metricsInput({ aiUsage: {}, providerCost: null }));
  assert.equal(record.aiUsage.totalTokens, null);
  assert.equal(record.aiUsage.turns, null);
  assert.equal(record.providerCost.available, false);
  assert.equal(record.providerCost.amount, null);

  const summary = summarizeDeliveryMetrics([record]);
  assert.equal(summary.overall.aiUsage.totalTokens.known, 0);
  assert.equal(summary.overall.aiUsage.totalTokens.unknown, 1);
  assert.equal(summary.overall.aiUsage.totalTokens.total, null);
  assert.equal(summary.overall.aiUsage.credits.total, null);
});

test('explicit token total must reconcile with input plus output tokens', () => {
  assert.throws(() => createDeliveryMetrics(metricsInput({
    aiUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 999 }
  })), /must equal inputTokens \+ outputTokens/);
});

test('summary produces comparable repository/risk/provider groups with token and credit distributions', () => {
  const first = createDeliveryMetrics(metricsInput());
  const second = createDeliveryMetrics(metricsInput({
    pullRequestNumber: 43,
    materialHeadSha: SHA_B,
    aiUsage: { turns: 3, credits: 2.5, inputTokens: 200, outputTokens: 100 },
    durationsMs: { ciQueue: 500, ciExecution: 10000, audit: 0, endToEnd: 15000 },
    providerCost: { amount: 0.08, currency: 'USD' }
  }));
  const summary = summarizeDeliveryMetrics([first, second]);
  const group = summary.byRepositoryRiskProvider['acme/example|fast|codex'];

  assert.equal(summary.totalDeliveries, 2);
  assert.equal(group.deliveries, 2);
  assert.equal(group.endToEndMs.avg, 30000);
  assert.equal(group.endToEndMs.p50, 15000);
  assert.equal(group.endToEndMs.p95, 45000);
  assert.equal(group.providerCostTotals.USD, 0.2);
  assert.equal(group.aiUsage.totalTokens.known, 2);
  assert.equal(group.aiUsage.totalTokens.unknown, 0);
  assert.equal(group.aiUsage.totalTokens.total, 450);
  assert.equal(group.aiUsage.totalTokens.avg, 225);
  assert.equal(group.aiUsage.totalTokens.p50, 150);
  assert.equal(group.aiUsage.totalTokens.p95, 300);
  assert.equal(group.aiUsage.credits.total, 4);
});

test('stage telemetry is optional and aggregates only observations that actually exist', () => {
  const first = createDeliveryMetrics(metricsInput({
    aiUsageByStage: {
      implementation: { turns: 2, credits: 1, inputTokens: 80, outputTokens: 40 },
      audit: { turns: 1, credits: 0.5, inputTokens: 30, outputTokens: 20 }
    }
  }));
  const second = createDeliveryMetrics(metricsInput({
    pullRequestNumber: 43,
    materialHeadSha: SHA_B,
    aiUsageByStage: {
      implementation: { turns: 3, credits: 2, inputTokens: 120, outputTokens: 60 }
    }
  }));
  const summary = summarizeDeliveryMetrics([first, second]);
  const implementation = summary.byRepositoryRiskProviderStage['acme/example|fast|codex|implementation'];
  const audit = summary.byRepositoryRiskProviderStage['acme/example|fast|codex|audit'];

  assert.equal(implementation.observations, 2);
  assert.equal(implementation.aiUsage.totalTokens.total, 300);
  assert.equal(implementation.aiUsage.credits.total, 3);
  assert.equal(audit.observations, 1);
  assert.equal(audit.aiUsage.totalTokens.total, 50);
});

test('stage telemetry rejects unsupported usage fields instead of accepting opaque provider data', () => {
  assert.throws(() => createDeliveryMetrics(metricsInput({
    aiUsageByStage: { implementation: { inputTokens: 10, cacheKey: 'secret-ish' } }
  })), /unsupported field/);
});

test('baseline comparison derives reduction and speedup from measured end-to-end time', () => {
  const comparison = compareAgainstBaseline(createDeliveryMetrics(metricsInput({
    durationsMs: { ciQueue: 1000, ciExecution: 100000, audit: 0, endToEnd: 128000 }
  })), 1255000);

  assert.ok(comparison.reductionPercent > 89);
  assert.ok(comparison.speedup > 9);
});

test('metrics store upsert is idempotent per repository/PR/material SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dv2-metrics-'));
  const filePath = join(dir, 'metrics.json');
  const first = createDeliveryMetrics(metricsInput());
  await upsertDeliveryMetrics(filePath, first);
  await upsertDeliveryMetrics(filePath, first);
  let store = await loadDeliveryMetricsStore(filePath);
  assert.equal(store.records.length, 1);

  const updated = createDeliveryMetrics(metricsInput({ providerCalls: 2, terminalReason: 'terminal' }));
  await upsertDeliveryMetrics(filePath, updated);
  store = await loadDeliveryMetricsStore(filePath);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].providerCalls, 2);
  assert.equal(store.records[0].terminalReason, 'terminal');
});

test('metrics reject unsupported risk and negative timing/cost inputs', () => {
  assert.throws(() => createDeliveryMetrics(metricsInput({ risk: 'tiny' })), /Unknown risk profile/);
  assert.throws(() => createDeliveryMetrics(metricsInput({
    durationsMs: { ciQueue: -1, ciExecution: 1, audit: 0, endToEnd: 1 }
  })), /non-negative integer/);
  assert.throws(() => createDeliveryMetrics(metricsInput({
    providerCost: { amount: -0.01, currency: 'USD' }
  })), /non-negative finite number/);
});
