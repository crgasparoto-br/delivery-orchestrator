import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { initializeResumeObservability } from '../scripts/resume-delivery-v2-controller.mjs';
import {
  createControllerObservability,
  recordControllerProviderObservation
} from '../src/v2/controller-observability.mjs';

const initialController = await readFile(new URL('../scripts/run-delivery-v2-controller.mjs', import.meta.url), 'utf8');
const resumeController = await readFile(new URL('../scripts/resume-delivery-v2-controller.mjs', import.meta.url), 'utf8');

test('initial controller records deterministic zero-call audits so duration is not dropped', () => {
  assert.doesNotMatch(initialController, /if \(lastAudit\.providerCalls !== 0\)/);
  assert.match(initialController, /usage: lastAudit\.providerCalls === 0\s*\? \{ providerCalls: 0 \}\s*: \(lastAudit\.modelUsage \?\? \{\}\)/);
  assert.match(initialController, /durationMs: runDurationMs\(auditRun\)/);
});

test('legacy resume initializes partial observability instead of disabling future telemetry', () => {
  const migrated = initializeResumeObservability({}, { startedAtMs: 1000 });
  assert.equal(migrated.historyComplete, false);
  assert.equal(migrated.observability.providerCalls, 0);

  const afterWorker = recordControllerProviderObservation(migrated.observability, {
    runId: 10,
    stage: 'implementation',
    provider: 'copilot',
    usage: { turns: 2 },
    evidenceRef: 'run:10'
  });
  const afterAudit = recordControllerProviderObservation(afterWorker, {
    runId: 11,
    stage: 'audit',
    usage: { providerCalls: 0 },
    durationMs: 250,
    evidenceRef: 'run:11'
  });

  assert.equal(afterAudit.providerCalls, 1);
  assert.deepEqual(afterAudit.providerRunIds, [10]);
  assert.deepEqual(afterAudit.observedRunIds, [10, 11]);
  assert.equal(afterAudit.auditDurationMs, 250);
  assert.deepEqual(afterAudit.evidenceRefs, ['run:10', 'run:11']);
});

test('resume controller persists partial legacy telemetry without fabricating historical totals', () => {
  assert.match(resumeController, /createControllerObservability/);
  assert.doesNotMatch(resumeController, /observability[\s\S]{0,160}: null;/);
  assert.doesNotMatch(resumeController, /if \(!observability\) return;/);
  assert.match(resumeController, /observabilityHistoryComplete/);
  assert.match(resumeController, /partial-legacy-observability/);
  assert.match(resumeController, /observedProviderCalls/);
  assert.match(resumeController, /partialMetrics/);
});


test('resume persists failed remediation worker observation before surfacing failure', () => {
  const recoveredThrow = resumeController.indexOf(
    'persisted remediation worker failed: ${run.html_url}'
  );
  const recoveredRecord = resumeController.lastIndexOf(
    'await recordWorkerUsage(run);',
    recoveredThrow
  );
  const recoveredPersist = resumeController.lastIndexOf(
    "nextAction: 'remediation-worker-failed'",
    recoveredThrow
  );
  const recoveredStatus = resumeController.lastIndexOf(
    "description: 'Delivery V2 remediation worker failed'",
    recoveredThrow
  );

  assert.ok(recoveredRecord >= 0);
  assert.ok(recoveredRecord < recoveredPersist);
  assert.ok(recoveredPersist < recoveredStatus);
  assert.ok(recoveredStatus < recoveredThrow);

  const dispatchedThrow = resumeController.indexOf(
    'throw new Error(`remediation worker failed: ${worker.html_url}`);'
  );
  const dispatchedRecord = resumeController.lastIndexOf(
    'await recordWorkerUsage(worker);',
    dispatchedThrow
  );
  const dispatchedPersist = resumeController.lastIndexOf(
    "nextAction: 'remediation-worker-failed'",
    dispatchedThrow
  );
  const dispatchedStatus = resumeController.lastIndexOf(
    "description: 'Delivery V2 remediation worker failed'",
    dispatchedThrow
  );

  assert.ok(dispatchedRecord >= 0);
  assert.ok(dispatchedRecord < dispatchedPersist);
  assert.ok(dispatchedPersist < dispatchedStatus);
  assert.ok(dispatchedStatus < dispatchedThrow);
});


test('initial and resumed controllers accumulate every terminal CI run before state transition', () => {
  for (const body of [initialController, resumeController]) {
    assert.match(body, /recordControllerCiObservation/);

    const sourceIndex = body.indexOf('latestSourceRun = observed.sourceRun;');
    const recordIndex = body.indexOf(
      'observability = recordControllerCiObservation(observability',
      sourceIndex
    );
    const resultIndex = body.indexOf(
      "type: 'ci-result'",
      sourceIndex
    );

    assert.ok(sourceIndex >= 0);
    assert.ok(recordIndex > sourceIndex);
    assert.ok(resultIndex > recordIndex);
  }

  assert.doesNotMatch(
    resumeController,
    /ciQueue:\s*ciQueueDurationMs\(latestSourceRun\)/
  );
  assert.doesNotMatch(
    resumeController,
    /ciExecution:\s*runDurationMs\(latestSourceRun\)/
  );
  assert.match(
    resumeController,
    /ciQueue:\s*observability\.ciQueueDurationMs/
  );
  assert.match(
    resumeController,
    /ciExecution:\s*observability\.ciExecutionDurationMs/
  );
});


test('both controllers persist failed audit telemetry before surfacing workflow failure', () => {
  for (const body of [initialController, resumeController]) {
    const throwIndex = body.indexOf(
      '`independent audit workflow failed: ${auditRun.html_url}`'
    );

    assert.ok(throwIndex >= 0);

    const recordIndex = body.lastIndexOf(
      'recordControllerAuditWorkflowFailure(observability',
      throwIndex
    );

    const partialIndex = body.lastIndexOf(
      'createControllerPartialMetrics({',
      throwIndex
    );

    const persistIndex = body.lastIndexOf(
      "nextAction: 'audit-workflow-failed'",
      throwIndex
    );

    const resultIndex = body.lastIndexOf(
      "metricsStatus: 'partial-audit-workflow-failure'",
      throwIndex
    );

    const writeIndex = body.lastIndexOf(
      'await writeFile(',
      throwIndex
    );

    assert.ok(recordIndex >= 0);
    assert.ok(recordIndex < partialIndex);
    assert.ok(partialIndex < persistIndex);
    assert.ok(persistIndex < resultIndex);
    assert.ok(resultIndex < writeIndex);
    assert.ok(writeIndex < throwIndex);

    const failureWindow = body.slice(recordIndex, throwIndex);

    assert.match(
      failureWindow,
      /providerAccountingComplete:\s*observability\.providerAccountingComplete/
    );

    assert.match(
      failureWindow,
      /providerCalls:\s*partialMetrics\.providerCalls/
    );

    assert.match(
      failureWindow,
      /observedProviderCalls:\s*partialMetrics\.observedProviderCalls/
    );

    assert.match(failureWindow, /terminalReason/);
  }
});

test('resume marks a partial historical provider ledger as incomplete history while remaining usable', () => {
  let observability = createControllerObservability({
    startedAtMs: 1000
  });

  observability = recordControllerProviderObservation(
    observability,
    {
      runId: 94001,
      stage: 'implementation',
      provider: 'codex',
      usage: { turns: 1 }
    }
  );

  observability = recordControllerProviderObservation(
    observability,
    {
      runId: 94002,
      stage: 'implementation',
      provider: 'codex',
      usage: { turns: 1 }
    }
  );

  const persisted = JSON.parse(JSON.stringify(observability));

  delete persisted.providerLedgerHistoryComplete;
  persisted.providerRunLedger =
    persisted.providerRunLedger.slice(1);

  const resumed = initializeResumeObservability(
    {
      observability: persisted,
      observabilityHistoryComplete: true
    },
    { startedAtMs: 2000 }
  );

  assert.equal(
    resumed.observability.providerLedgerHistoryComplete,
    false
  );

  assert.equal(resumed.historyComplete, false);
});


test('resume persists metrics when only provider ledger history is partial', () => {
  assert.match(
    resumeController,
    /const metricsHistoryPublishable =[\s\S]*?observability\.providerAccountingComplete[\s\S]*?observability\.ciRunIds\.length > 0/
  );

  assert.match(
    resumeController,
    /providerLedgerHistoryComplete[\s\S]*?'partial-provider-ledger'/
  );

  assert.doesNotMatch(
    resumeController,
    /const metrics = observabilityHistoryComplete \? createControllerDeliveryMetrics/
  );
});
