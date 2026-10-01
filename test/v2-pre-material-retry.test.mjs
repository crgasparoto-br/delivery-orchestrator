import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  boundedPreMaterialRetryContext,
  classifyPreMaterialWorkerFailure,
  decidePreMaterialRetry
} from '../src/v2/pre-material-recovery.mjs';
import { evaluateReentry } from '../scripts/guard-delivery-v2-reentry.mjs';
import { transferBootstrapControllerAuthority } from '../scripts/run-delivery-v2-controller.mjs';

function breakerOutput(details = 'context-rebuild circuit breaker tripped: rebuild_factor=35.63 cumulative_input_tokens=2931337 thresholds=35/1000000') {
  return {
    items: [{ type: 'report_incomplete', reason: 'infrastructure_error', details }],
    errors: []
  };
}

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 273,
    baseBranch: 'main',
    provider: 'codex',
    model: null,
    requestedRisk: 'auto',
    effectiveRisk: 'critical',
    implementationAttempts: 1,
    status: 'reserved-initial-attempt',
    controllerRunId: 36361552815,
    workerRunId: null,
    workerWorkflow: 'delivery-v2-worker-codex-critical.lock.yml',
    dispatchNonce: 'nonce-attempt-1',
    ...overrides
  };
}

function evaluate({ bootstrapLease = lease(), recoveredWorkerRun = null } = {}) {
  return evaluateReentry({
    pullRequest: null,
    stateEnvelope: null,
    adoptionEnvelope: null,
    bootstrapLease,
    targetRepository: 'crgasparoto-br/delivery-orchestrator',
    issueNumber: 273,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    recoveredWorkerRun,
    currentControllerHeadSha: 'a'.repeat(40),
    bootstrapControllerHeadSha: 'a'.repeat(40)
  });
}

test('recognizes only the exact context-rebuild infrastructure report with trusted no-patch evidence', () => {
  const failure = classifyPreMaterialWorkerFailure({
    workerConclusion: 'failure',
    hasPatch: false,
    agentOutput: breakerOutput()
  });
  assert.equal(failure.recoverable, true);
  assert.equal(failure.classification, 'context-rebuild-circuit-breaker');
  assert.equal(failure.failureClass, 'infrastructure');
  assert.equal(failure.evidence.rebuildFactor, 35.63);
  assert.equal(failure.evidence.cumulativeInputTokens, 2931337);
});

test('recognized context rebuild remains recoverable when workflow is technically successful', () => {
  const failure = classifyPreMaterialWorkerFailure({
    workerConclusion: 'success',
    hasPatch: false,
    agentOutput: breakerOutput()
  });
  assert.equal(failure.recoverable, true);
  assert.equal(failure.classification, 'context-rebuild-circuit-breaker');
  assert.equal(failure.failureClass, 'infrastructure');
  assert.deepEqual(decidePreMaterialRetry({ failure, currentAttempt: 1, maxAttempts: 3 }), {
    action: 'retry', currentAttempt: 1, nextAttempt: 2, maxAttempts: 3
  });
});

test('random infrastructure_error is not recoverable', () => {
  const failure = classifyPreMaterialWorkerFailure({
    workerConclusion: 'failure',
    hasPatch: false,
    agentOutput: breakerOutput('network is flaky')
  });
  assert.equal(failure.recoverable, false);
  assert.equal(failure.classification, 'unclassified-infrastructure-error');
});

test('missing, invalid or material has_patch evidence fails closed', () => {
  for (const hasPatch of [undefined, null, true, 'false']) {
    const failure = classifyPreMaterialWorkerFailure({
      workerConclusion: 'failure',
      hasPatch,
      agentOutput: breakerOutput()
    });
    assert.equal(failure.recoverable, false);
    assert.equal(failure.classification, 'material-status-not-trusted-no-patch');
  }
});

test('retry consumes the next implementation slot and exhausts exactly at the configured ceiling', () => {
  const failure = classifyPreMaterialWorkerFailure({
    workerConclusion: 'failure',
    hasPatch: false,
    agentOutput: breakerOutput()
  });
  assert.deepEqual(decidePreMaterialRetry({ failure, currentAttempt: 1, maxAttempts: 3 }), {
    action: 'retry', currentAttempt: 1, nextAttempt: 2, maxAttempts: 3
  });
  assert.deepEqual(decidePreMaterialRetry({ failure, currentAttempt: 2, maxAttempts: 3 }), {
    action: 'retry', currentAttempt: 2, nextAttempt: 3, maxAttempts: 3
  });
  assert.deepEqual(decidePreMaterialRetry({ failure, currentAttempt: 3, maxAttempts: 3 }), {
    action: 'budget-exhausted', currentAttempt: 3, maxAttempts: 3
  });
});

test('bounded retry context contains only durable retry identity, not transcript/history', () => {
  const failure = classifyPreMaterialWorkerFailure({
    workerConclusion: 'failure',
    hasPatch: false,
    agentOutput: breakerOutput()
  });
  const context = boundedPreMaterialRetryContext({
    failure,
    previousAttempt: 1,
    previousWorkerRunId: 36361571364
  });
  assert.equal(context.kind, 'pre-material-retry');
  assert.equal(context.previousAttempt, 1);
  assert.equal(context.previousWorkerRunId, 36361571364);
  assert.deepEqual(Object.keys(context.failure).sort(), ['classification', 'failureClass', 'failureStage', 'reason']);
  assert.equal(JSON.stringify(context).includes('2931337'), false);
});

test('crash after reservation but before dispatch reuses the same slot and nonce', () => {
  const decision = evaluate();
  assert.equal(decision.runController, true);
  assert.equal(decision.reuseReservedAttempt, true);
  assert.equal(decision.priorInitialAttempts, 1);
  assert.equal(decision.dispatchNonce, 'nonce-attempt-1');
  assert.equal(decision.nextAction, 'dispatch-reserved-initial-attempt');
});

test('completed failed worker without persisted classification is recovered for deterministic classification', () => {
  const decision = evaluate({
    recoveredWorkerRun: { id: 36361571364, status: 'completed', conclusion: 'failure' }
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.recoverWorkerRunId, 36361571364);
  assert.equal(decision.priorInitialAttempts, 1);
  assert.equal(decision.nextAction, 'recover-initial-attempt');
});

test('persisted recoverable failure reserves the next slot on reentry without changing the ceiling', () => {
  const decision = evaluate({
    bootstrapLease: lease({
      lastFailure: {
        attempt: 1,
        workerRunId: 36361571364,
        workerConclusion: 'failure',
        recoverable: true,
        failureStage: 'pre-material',
        failureClass: 'infrastructure',
        classification: 'context-rebuild-circuit-breaker'
      }
    }),
    recoveredWorkerRun: { id: 36361571364, status: 'completed', conclusion: 'failure' }
  });
  assert.equal(decision.runController, true);
  assert.equal(decision.status, 'retry-initial-delivery');
  assert.equal(decision.priorInitialAttempts, 1);
  assert.equal(decision.nextAction, 'retry-initial-worker');
});

test('third recoverable CRITICAL failure escalates instead of creating a fourth attempt', () => {
  const decision = evaluate({
    bootstrapLease: lease({
      implementationAttempts: 3,
      dispatchNonce: 'nonce-attempt-3',
      lastFailure: {
        attempt: 3,
        workerRunId: 36361579999,
        workerConclusion: 'failure',
        recoverable: true,
        failureStage: 'pre-material',
        failureClass: 'infrastructure',
        classification: 'context-rebuild-circuit-breaker'
      }
    }),
    recoveredWorkerRun: { id: 36361579999, status: 'completed', conclusion: 'failure' }
  });
  assert.equal(decision.runController, false);
  assert.equal(decision.status, 'escalated-initial-budget-exhausted');
  assert.equal(decision.nextAction, 'human-escalation');
  assert.equal(decision.attempts.implementation, 3);
});

test('persisted nonrecoverable pre-material failure remains fail-closed', () => {
  const decision = evaluate({
    bootstrapLease: lease({
      status: 'escalated-initial-nonrecoverable',
      lastFailure: {
        attempt: 1,
        workerRunId: 36361570000,
        workerConclusion: 'failure',
        recoverable: false,
        failureStage: 'pre-material',
        failureClass: 'unknown',
        classification: 'unclassified-infrastructure-error'
      }
    })
  });
  assert.equal(decision.runController, false);
  assert.equal(decision.status, 'escalated-initial-nonrecoverable');
  assert.equal(decision.nextAction, 'human-escalation');
});

test('Codex workers skip the whole detection job without a material patch and keep AWF when detection runs', async () => {
  for (const risk of ['fast', 'standard', 'critical']) {
    const source = await readFile(`.github/workflows/delivery-v2-worker-codex-${risk}.md`, 'utf8');
    assert.match(source, /jobs:\n  detection:\n    if: needs\.agent\.outputs\.has_patch == 'true'/);

    const lock = await readFile(`.github/workflows/delivery-v2-worker-codex-${risk}.lock.yml`, 'utf8');
    const start = lock.indexOf('\n  detection:\n');
    assert.ok(start >= 0);
    const end = lock.indexOf('\n  safe_outputs:\n', start);
    const detection = lock.slice(start, end >= 0 ? end : undefined);
    assert.match(detection, /if: .*needs\.agent\.outputs\.has_patch == 'true'/);
    assert.match(detection, /- name: Install AWF binary/);
    assert.match(detection, /install_awf_binary\.sh/);
  }
});


test('bootstrap controller authorization mismatch retries the same material attempt', () => {
  const failure = classifyPreMaterialWorkerFailure({
    workerConclusion: 'failure',
    hasPatch: null,
    agentOutput: null,
    authorizationFailure: {
      classification: 'bootstrap-controller-run-mismatch',
      evidenceRef: 'https://github.com/example/actions/runs/2',
      activeControllerRunId: 22,
      persistedControllerRunId: 21
    }
  });

  assert.equal(failure.recoverable, true);
  assert.equal(failure.failureClass, 'control-plane-authorization');
  assert.equal(failure.retryMode, 'reuse-current-attempt');
  assert.deepEqual(decidePreMaterialRetry({
    failure,
    currentAttempt: 3,
    maxAttempts: 3
  }), {
    action: 'retry-same-attempt',
    currentAttempt: 3,
    nextAttempt: 3,
    maxAttempts: 3
  });
});

test('controller authority transfer preserves attempt and nonce while leaving one active controller', () => {
  const original = lease({
    controllerRunId: 21,
    implementationAttempts: 2,
    dispatchNonce: 'nonce-attempt-2',
    controllerHeadSha: 'a'.repeat(40)
  });
  const transferred = transferBootstrapControllerAuthority(original, {
    controllerRunId: 22,
    controllerHeadSha: 'b'.repeat(40)
  });

  assert.equal(transferred.controllerRunId, 22);
  assert.deepEqual(transferred.controllerRunHistory, [21]);
  assert.deepEqual(transferred.controllerProvenanceHistory, [{
    controllerRunId: 21,
    controllerHeadSha: 'a'.repeat(40)
  }]);
  assert.equal(transferred.implementationAttempts, 2);
  assert.equal(transferred.dispatchNonce, 'nonce-attempt-2');
  assert.equal(transferred.controllerHeadSha, 'b'.repeat(40));

  const repeated = transferBootstrapControllerAuthority(transferred, {
    controllerRunId: 22,
    controllerHeadSha: 'b'.repeat(40)
  });
  assert.deepEqual(repeated.controllerRunHistory, [21]);
  assert.deepEqual(repeated.controllerProvenanceHistory, [{
    controllerRunId: 21,
    controllerHeadSha: 'a'.repeat(40)
  }]);
});

test('same-attempt authorization retry is a reservable retry action', async () => {
  const source = await readFile(
    new URL('../scripts/run-delivery-v2-controller.mjs', import.meta.url),
    'utf8'
  );
  assert.match(
    source,
    /\['retry', 'retry-same-attempt'\]\.includes\(decision\.action\)/
  );
});
