import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { initializeResumeObservability } from '../scripts/resume-delivery-v2-controller.mjs';
import { recordControllerProviderObservation } from '../src/v2/controller-observability.mjs';

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
    'throw new Error(`persisted remediation worker failed: ${run.html_url}`);'
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
