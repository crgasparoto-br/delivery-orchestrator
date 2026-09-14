import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ciQueueDurationMs,
  createControllerObservability,
  recordControllerProviderObservation,
  createControllerDeliveryMetrics,
  runDurationMs
} from '../src/v2/controller-observability.mjs';

const finalCiRun = {
  created_at: '2026-09-13T20:00:00.000Z',
  run_started_at: '2026-09-13T20:00:01.000Z',
  updated_at: '2026-09-13T20:00:03.000Z'
};

function metricsInput(observability, overrides = {}) {
  return {
    observability,
    repository: 'owner/repo',
    issueNumber: 1,
    pullRequestNumber: 2,
    materialHeadSha: 'a'.repeat(40),
    risk: 'critical',
    provider: 'codex',
    classifier: { version: 'v', fingerprint: 'f' },
    attempts: { implementation: 1, audit: 1 },
    finalCiRun,
    change: { files: 1, additions: 1, deletions: 0 },
    terminalReason: 'ready-for-human-merge',
    nowMs: 2000,
    ...overrides
  };
}

test('provider observations survive reentry without double counting run IDs', () => {
  let state = createControllerObservability({ startedAtMs: 1000 });
  state = recordControllerProviderObservation(state, { runId: 10, stage: 'implementation', usage: { turns: 3, inputTokens: 10, outputTokens: 4, totalTokens: 14 }, evidenceRef: 'run:10' });
  state = recordControllerProviderObservation(state, { runId: 10, stage: 'implementation', usage: { turns: 99 } });
  state = recordControllerProviderObservation(state, { runId: 11, stage: 'audit', usage: {}, durationMs: 500, evidenceRef: 'run:11' });
  assert.equal(state.providerCalls, 2);
  assert.deepEqual(state.providerRunIds, [10, 11]);
  assert.deepEqual(state.observedRunIds, [10, 11]);
  assert.equal(state.aiUsageByStage.implementation.turns, 3);
  assert.equal(state.aiUsageByStage.audit.turns, null);
  assert.equal(state.auditDurationMs, 500);
  assert.deepEqual(state.evidenceRefs, ['run:10', 'run:11']);
});

test('deterministic zero-call audit preserves duration and evidence without incrementing provider calls', () => {
  let state = recordControllerProviderObservation(createControllerObservability({ startedAtMs: 1000 }), {
    runId: 99,
    stage: 'audit',
    usage: { providerCalls: 0 },
    durationMs: 500,
    evidenceRef: 'run:99'
  });
  state = recordControllerProviderObservation(state, {
    runId: 99,
    stage: 'audit',
    usage: { providerCalls: 0 },
    durationMs: 500,
    evidenceRef: 'run:99'
  });
  assert.equal(state.providerCalls, 0);
  assert.deepEqual(state.providerRunIds, []);
  assert.deepEqual(state.observedRunIds, [99]);
  assert.equal(state.auditDurationMs, 500);
  assert.deepEqual(state.evidenceRefs, ['run:99']);
});

test('unavailable workflow timing remains unknown while a real zero duration remains zero', () => {
  assert.equal(runDurationMs(null), null);
  assert.equal(ciQueueDurationMs(null), null);

  assert.equal(runDurationMs({ run_started_at: 'invalid', updated_at: 'invalid' }), null);
  assert.equal(ciQueueDurationMs({ created_at: 'invalid', run_started_at: 'invalid' }), null);

  assert.equal(runDurationMs({ run_started_at: '2026-09-13T20:00:00.000Z' }), null);
  assert.equal(runDurationMs({ updated_at: '2026-09-13T20:00:03.000Z' }), null);

  assert.equal(ciQueueDurationMs({ created_at: '2026-09-13T20:00:00.000Z' }), null);
  assert.equal(ciQueueDurationMs({ run_started_at: '2026-09-13T20:00:01.000Z' }), null);

  assert.equal(runDurationMs({
    run_started_at: '2026-09-13T20:00:03.000Z',
    updated_at: '2026-09-13T20:00:02.000Z'
  }), null);

  assert.equal(ciQueueDurationMs({
    created_at: '2026-09-13T20:00:02.000Z',
    run_started_at: '2026-09-13T20:00:01.000Z'
  }), null);

  assert.equal(runDurationMs({
    run_started_at: '2026-09-13T20:00:00.000Z',
    updated_at: '2026-09-13T20:00:00.000Z'
  }), 0);

  assert.equal(ciQueueDurationMs({
    created_at: '2026-09-13T20:00:00.000Z',
    run_started_at: '2026-09-13T20:00:00.000Z'
  }), 0);
});

test('final metrics preserve unknown usage instead of fabricating zero', () => {
  const state = recordControllerProviderObservation(createControllerObservability({ startedAtMs: 1000 }), { runId: 1, stage: 'audit', usage: {}, durationMs: 50 });
  const metrics = createControllerDeliveryMetrics(metricsInput(state));
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.aiUsage.turns, null);
  assert.equal(metrics.durationsMs.ciQueue, 1000);
  assert.equal(metrics.durationsMs.ciExecution, 2000);
  assert.equal(metrics.durationsMs.audit, 50);
  assert.equal(metrics.durationsMs.endToEnd, 1000);
});

test('final metrics fail closed instead of inventing zero CI timing', () => {
  const state = createControllerObservability({ startedAtMs: 1000 });
  assert.throws(() => createControllerDeliveryMetrics(metricsInput(state, { finalCiRun: null })), /timing is unavailable/);
});

test('provider invocation with unavailable usage is counted without fabricating token usage', () => {
  const state = recordControllerProviderObservation(
    createControllerObservability({ startedAtMs: 1000 }),
    {
      runId: 77,
      stage: 'implementation',
      usage: {},
      evidenceRef: 'run:77'
    }
  );

  assert.equal(state.providerCalls, 1);
  assert.deepEqual(state.providerRunIds, [77]);
  assert.deepEqual(state.observedRunIds, [77]);
  assert.equal(state.aiUsageByStage.implementation.turns, null);
  assert.equal(state.aiUsageByStage.implementation.credits, null);
  assert.equal(state.aiUsageByStage.implementation.inputTokens, null);
  assert.equal(state.aiUsageByStage.implementation.outputTokens, null);
  assert.equal(state.aiUsageByStage.implementation.totalTokens, null);
  assert.deepEqual(state.evidenceRefs, ['run:77']);
});
