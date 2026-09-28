import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  classifyWorkflowStageFailure,
  decideWorkflowStageRetry
} from '../src/v2/workflow-stage-recovery.mjs';

function breakerOutput() {
  return {
    errors: [],
    items: [{
      type: 'report_incomplete',
      reason: 'infrastructure_error',
      details: 'context-rebuild circuit breaker tripped: rebuild_factor=35.63 cumulative_input_tokens=2931337 thresholds=35/1000000'
    }]
  };
}

test('timed out and startup failure stages retry the same stage without consuming semantic budget', () => {
  for (const conclusion of ['timed_out', 'startup_failure']) {
    const failure = classifyWorkflowStageFailure({
      stage: 'ci-remediation',
      conclusion
    });
    assert.equal(failure.recoverable, true);
    assert.equal(failure.action, 'retry-same-stage');
    assert.equal(failure.failureClass, 'infrastructure');
    assert.deepEqual(decideWorkflowStageRetry({
      failure,
      retriesUsed: 0,
      maxRetries: 1
    }), {
      action: 'retry-same-stage',
      retriesUsed: 0,
      nextRetriesUsed: 1,
      maxRetries: 1
    });
  }
});

test('recognized context rebuild without patch retries remediation and hygiene stages', () => {
  for (const stage of ['ci-remediation', 'audit-remediation', 'technical-hygiene']) {
    const failure = classifyWorkflowStageFailure({
      stage,
      conclusion: 'failure',
      hasPatch: false,
      agentOutput: breakerOutput()
    });
    assert.equal(failure.recoverable, true);
    assert.equal(failure.action, 'retry-same-stage');
    assert.equal(failure.classification, 'context-rebuild-circuit-breaker');
  }
});

test('ambiguous failure and cancelled audit remain fail closed', () => {
  const ambiguous = classifyWorkflowStageFailure({
    stage: 'ci-remediation',
    conclusion: 'failure',
    hasPatch: false,
    agentOutput: { errors: ['framework failure'], items: [] }
  });
  assert.equal(ambiguous.recoverable, false);
  assert.equal(ambiguous.action, 'fail-closed');

  const cancelledAudit = classifyWorkflowStageFailure({
    stage: 'independent-audit',
    conclusion: 'cancelled'
  });
  assert.equal(cancelledAudit.recoverable, false);
  assert.equal(cancelledAudit.action, 'fail-closed');
});

test('failed stage that changed material head never retries automatically', () => {
  const failure = classifyWorkflowStageFailure({
    stage: 'audit-remediation',
    conclusion: 'timed_out',
    materialHeadChanged: true
  });
  assert.equal(failure.recoverable, false);
  assert.equal(failure.classification, 'material-changed-during-failed-stage');
});

test('stage retry budget is bounded independently from semantic attempt counters', () => {
  const failure = classifyWorkflowStageFailure({
    stage: 'technical-hygiene',
    conclusion: 'startup_failure'
  });
  assert.deepEqual(decideWorkflowStageRetry({
    failure,
    retriesUsed: 1,
    maxRetries: 1
  }), {
    action: 'retry-budget-exhausted',
    retriesUsed: 1,
    maxRetries: 1
  });
});


test('controller wires the recovery matrix into every bounded downstream stage', async () => {
  const source = await readFile(
    new URL('../scripts/run-delivery-v2-controller.mjs', import.meta.url),
    'utf8'
  );

  assert.match(source, /const MAX_INFRA_STAGE_RETRIES = 1/);
  for (const stage of [
    'ci-remediation',
    'audit-remediation',
    'technical-hygiene',
    'independent-audit'
  ]) {
    assert.match(
      source,
      new RegExp(`stage: '${stage}'`),
      `controller must route ${stage} through deterministic stage recovery`
    );
  }
  assert.match(source, /materialHeadChanged/);
  assert.match(source, /workerEvidence = await downloadInitialWorkerEvidence/);
});
