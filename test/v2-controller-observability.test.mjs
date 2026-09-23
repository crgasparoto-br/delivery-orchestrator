import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ciQueueDurationMs,
  createControllerObservability,
  createControllerPartialMetrics,
  normalizeControllerObservability,
  recordControllerAuditWorkflowFailure,
  recordControllerCiObservation,
  recordControllerProviderObservation,
  createControllerDeliveryMetrics,
  runDurationMs
} from '../src/v2/controller-observability.mjs';

const finalCiRun = {
  id: 501,
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
    change: { files: 1, additions: 1, deletions: 0 },
    terminalReason: 'ready-for-human-merge',
    nowMs: 2000,
    ...overrides
  };
}

test('provider observations survive reentry without double counting run IDs', () => {
  let state = createControllerObservability({ startedAtMs: 1000 });
  state = recordControllerProviderObservation(state, { runId: 10, stage: 'implementation', provider: 'copilot', usage: { turns: 3, inputTokens: 10, outputTokens: 4, totalTokens: 14 }, evidenceRef: 'run:10' });
  state = recordControllerProviderObservation(state, { runId: 10, stage: 'implementation', provider: 'copilot', usage: { turns: 99 } });
  state = recordControllerProviderObservation(state, { runId: 11, stage: 'audit', provider: 'copilot', usage: {}, durationMs: 500, evidenceRef: 'run:11' });
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
  let state = recordControllerProviderObservation(createControllerObservability({ startedAtMs: 1000 }), { runId: 1, stage: 'audit', provider: 'copilot', usage: {}, durationMs: 50 });
  state = recordControllerCiObservation(state, { run: finalCiRun, evidenceRef: 'ci:501' });
  const metrics = createControllerDeliveryMetrics(metricsInput(state));
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.aiUsage.turns, null);
  assert.equal(metrics.durationsMs.ciQueue, 1000);
  assert.equal(metrics.durationsMs.ciExecution, 2000);
  assert.equal(metrics.durationsMs.audit, 50);
  assert.equal(metrics.durationsMs.endToEnd, 1000);
});

test('final metrics fail closed instead of inventing incomplete CI timing', () => {
  const state = createControllerObservability({ startedAtMs: 1000 });
  assert.throws(
    () => createControllerDeliveryMetrics(metricsInput(state)),
    /no observed workflow run/
  );
});

test('provider invocation with unavailable usage is counted without fabricating token usage', () => {
  const state = recordControllerProviderObservation(
    createControllerObservability({ startedAtMs: 1000 }),
    {
      runId: 77,
      stage: 'implementation',
      provider: 'copilot',
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


test('CI timing accumulates every terminal workflow run exactly once across multiple cycles', () => {
  let state = createControllerObservability({ startedAtMs: 1000 });

  const first = {
    id: 601,
    created_at: '2026-09-13T20:00:00.000Z',
    run_started_at: '2026-09-13T20:00:01.000Z',
    updated_at: '2026-09-13T20:00:03.000Z'
  };
  const second = {
    id: 602,
    created_at: '2026-09-13T20:10:00.000Z',
    run_started_at: '2026-09-13T20:10:02.000Z',
    updated_at: '2026-09-13T20:10:07.000Z'
  };

  state = recordControllerCiObservation(state, {
    run: first,
    evidenceRef: 'ci:601'
  });
  state = recordControllerCiObservation(state, {
    run: second,
    evidenceRef: 'ci:602'
  });

  // Re-entry/re-observation of the same workflow run must be idempotent.
  state = recordControllerCiObservation(state, {
    run: second,
    evidenceRef: 'ci:602-duplicate'
  });

  assert.equal(state.ciTimingHistoryComplete, true);
  assert.deepEqual(state.ciRunIds, [601, 602]);
  assert.equal(state.ciQueueDurationMs, 3000);
  assert.equal(state.ciExecutionDurationMs, 7000);

  const metrics = createControllerDeliveryMetrics(metricsInput(state));
  assert.equal(metrics.durationsMs.ciQueue, 3000);
  assert.equal(metrics.durationsMs.ciExecution, 7000);
  assert.ok(!state.evidenceRefs.includes('ci:602-duplicate'));
});

test('legacy observability without cumulative CI fields is explicitly partial, never zero-complete', () => {
  const current = createControllerObservability({ startedAtMs: 1000 });
  const {
    ciTimingHistoryComplete,
    ciRunIds,
    ciQueueDurationMs,
    ciExecutionDurationMs,
    ...legacy
  } = current;

  const normalized = normalizeControllerObservability(legacy);

  assert.equal(normalized.ciTimingHistoryComplete, false);
  assert.deepEqual(normalized.ciRunIds, []);
  assert.equal(normalized.ciQueueDurationMs, 0);
  assert.equal(normalized.ciExecutionDurationMs, 0);

  assert.throws(
    () => createControllerDeliveryMetrics(metricsInput(normalized)),
    /CI timing history is incomplete/
  );
});

test('CI observation fails closed when required timing is unavailable', () => {
  const state = createControllerObservability({ startedAtMs: 1000 });

  assert.throws(
    () => recordControllerCiObservation(state, {
      run: {
        id: 603,
        created_at: '2026-09-13T20:00:00.000Z',
        updated_at: '2026-09-13T20:00:03.000Z'
      }
    }),
    /CI timing is unavailable/
  );
});


test('failed audit workflow preserves known duration while provider calls remain explicitly unknown', () => {
  let state = createControllerObservability({ startedAtMs: 1000 });

  state = recordControllerAuditWorkflowFailure(state, {
    runId: 701,
    durationMs: 750,
    evidenceRef: 'audit:701'
  });

  state = recordControllerAuditWorkflowFailure(state, {
    runId: 701,
    durationMs: 9999,
    evidenceRef: 'audit:701-duplicate'
  });

  assert.equal(state.providerCalls, 0);
  assert.equal(state.providerAccountingComplete, false);
  assert.deepEqual(state.failedAuditRunIds, [701]);
  assert.equal(state.auditTimingComplete, true);
  assert.equal(state.auditDurationMs, 750);
  assert.deepEqual(state.evidenceRefs, ['audit:701']);

  const partial = createControllerPartialMetrics({
    observability: state,
    terminalReason: 'independent-audit-workflow-failure',
    nowMs: 2000
  });

  assert.equal(partial.providerCalls, null);
  assert.equal(partial.observedProviderCalls, 0);
  assert.equal(partial.providerAccountingComplete, false);
  assert.equal(partial.durationsMs.audit, 750);
  assert.equal(
    partial.terminalReason,
    'independent-audit-workflow-failure'
  );

  assert.throws(
    () => createControllerDeliveryMetrics(metricsInput(state)),
    /provider accounting is incomplete/
  );
});

test('failed audit workflow with unavailable timing remains unknown instead of zero', () => {
  const state = recordControllerAuditWorkflowFailure(
    createControllerObservability({ startedAtMs: 1000 }),
    {
      runId: 702,
      durationMs: null,
      evidenceRef: 'audit:702'
    }
  );

  assert.equal(state.providerAccountingComplete, false);
  assert.deepEqual(state.failedAuditRunIds, [702]);
  assert.equal(state.auditTimingComplete, false);
  assert.equal(state.auditDurationMs, 0);

  const partial = createControllerPartialMetrics({
    observability: state,
    terminalReason: 'independent-audit-workflow-failure',
    nowMs: 2000
  });

  assert.equal(partial.providerCalls, null);
  assert.equal(partial.durationsMs.audit, null);
});

test('legacy observability without failed-audit accounting is explicitly incomplete', () => {
  const current = createControllerObservability({ startedAtMs: 1000 });

  const {
    providerAccountingComplete,
    failedAuditRunIds,
    auditTimingComplete,
    ...legacy
  } = current;

  const normalized = normalizeControllerObservability(legacy);

  assert.equal(normalized.providerAccountingComplete, false);
  assert.deepEqual(normalized.failedAuditRunIds, []);
  assert.equal(normalized.auditTimingComplete, false);
});


test('auditAttempt survives canonical controller observability normalization and ledger persistence', () => {
  let state = createControllerObservability({ startedAtMs: 1000 });

  state = recordControllerProviderObservation(state, {
    runId: 88001,
    stage: 'audit',
    phase: 'audit',
    provider: 'copilot',
    durationMs: 0,
    implementationAttempt: 2,
    remediationAttempt: 1,
    auditAttempt: 3,
    usage: { turns: 1 },
    evidenceRef: 'run:88001'
  });

  assert.equal(state.providerRunLedger.length, 1);
  assert.equal(state.providerRunLedger[0].phase, 'audit');
  assert.equal(state.providerRunLedger[0].implementationAttempt, 2);
  assert.equal(state.providerRunLedger[0].remediationAttempt, 1);
  assert.equal(state.providerRunLedger[0].auditAttempt, 3);

  const normalized = normalizeControllerObservability(
    JSON.parse(JSON.stringify(state))
  );

  assert.equal(normalized.providerRunLedger[0].auditAttempt, 3);
});
