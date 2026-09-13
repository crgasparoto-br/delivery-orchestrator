import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createControllerObservability,
  recordControllerProviderObservation,
  createControllerDeliveryMetrics
} from '../src/v2/controller-observability.mjs';

test('provider observations survive reentry without double counting run IDs', () => {
  let state = createControllerObservability({ startedAtMs: 1000 });
  state = recordControllerProviderObservation(state, { runId: 10, stage: 'implementation', usage: { turns: 3, inputTokens: 10, outputTokens: 4, totalTokens: 14 }, evidenceRef: 'run:10' });
  state = recordControllerProviderObservation(state, { runId: 10, stage: 'implementation', usage: { turns: 99 } });
  state = recordControllerProviderObservation(state, { runId: 11, stage: 'audit', usage: {}, durationMs: 500, evidenceRef: 'run:11' });
  assert.equal(state.providerCalls, 2);
  assert.equal(state.aiUsageByStage.implementation.turns, 3);
  assert.equal(state.aiUsageByStage.audit.turns, null);
  assert.equal(state.auditDurationMs, 500);
  assert.deepEqual(state.evidenceRefs, ['run:10', 'run:11']);
});

test('deterministic audit rejection with zero provider calls does not increment resumed telemetry', () => {
  const state = recordControllerProviderObservation(createControllerObservability({ startedAtMs: 1000 }), {
    runId: 99,
    stage: 'audit',
    usage: { providerCalls: 0 },
    durationMs: 500,
    evidenceRef: 'run:99'
  });
  assert.equal(state.providerCalls, 0);
  assert.deepEqual(state.providerRunIds, []);
  assert.equal(state.auditDurationMs, 0);
  assert.deepEqual(state.evidenceRefs, []);
});

test('final metrics preserve unknown usage instead of fabricating zero', () => {
  const state = recordControllerProviderObservation(createControllerObservability({ startedAtMs: 1000 }), { runId: 1, stage: 'audit', usage: {}, durationMs: 50 });
  const metrics = createControllerDeliveryMetrics({
    observability: state,
    repository: 'owner/repo',
    issueNumber: 1,
    pullRequestNumber: 2,
    materialHeadSha: 'a'.repeat(40),
    risk: 'critical',
    provider: 'codex',
    classifier: { version: 'v', fingerprint: 'f' },
    attempts: { implementation: 1, audit: 1 },
    finalCiRun: null,
    change: { files: 1, additions: 1, deletions: 0 },
    terminalReason: 'ready-for-human-merge',
    nowMs: 2000
  });
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.aiUsage.turns, null);
  assert.equal(metrics.durationsMs.endToEnd, 1000);
});
