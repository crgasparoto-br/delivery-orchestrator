const CONTEXT_REBUILD_RE = /^context-rebuild circuit breaker tripped: rebuild_factor=([0-9]+(?:\.[0-9]+)?) cumulative_input_tokens=([0-9]+) thresholds=([0-9]+(?:\.[0-9]+)?)\/([0-9]+)$/;

function failClosed(classification, reason, extra = {}) {
  return Object.freeze({
    recoverable: false,
    classification,
    reason,
    failureStage: 'pre-material',
    failureClass: 'unknown',
    ...extra
  });
}

export function classifyStructuredContextRebuildFailure({
  workerConclusion,
  hasPatch,
  materialPublished = null,
  agentOutput
} = {}) {
  const terminalConclusion = String(workerConclusion ?? '').trim().toLowerCase();
  if (!['success', 'failure'].includes(terminalConclusion)) {
    return failClosed(
      'unsupported-worker-conclusion',
      'context-rebuild recovery requires a terminal success/failure workflow outcome'
    );
  }

  if (!agentOutput || typeof agentOutput !== 'object' || Array.isArray(agentOutput)) {
    return failClosed('invalid-agent-output', 'structured agent output is unavailable');
  }

  const errors = Array.isArray(agentOutput.errors) ? agentOutput.errors : null;
  const items = Array.isArray(agentOutput.items) ? agentOutput.items : null;
  if (!errors || errors.length !== 0 || !items || items.length !== 1) {
    return failClosed(
      'ambiguous-agent-output',
      'structured agent output is ambiguous or contains framework errors'
    );
  }

  const item = items[0];
  if (
    !item
    || item.type !== 'report_incomplete'
    || item.reason !== 'infrastructure_error'
    || typeof item.details !== 'string'
  ) {
    return failClosed(
      'unclassified-pre-material-worker-failure',
      'worker failure is not the recognized infrastructure report'
    );
  }

  const match = item.details.match(CONTEXT_REBUILD_RE);
  if (!match) {
    return failClosed(
      'unclassified-infrastructure-error',
      'infrastructure error is not the recognized context-rebuild circuit breaker'
    );
  }

  const parsedEvidence = Object.freeze({
    rebuildFactor: Number(match[1]),
    cumulativeInputTokens: Number(match[2]),
    maxRebuildFactor: Number(match[3]),
    rebuildMinCumulativeInputTokens: Number(match[4]),
    localPatchPresent: hasPatch === true,
    materialPublished: materialPublished === true
  });

  if (materialPublished === true) {
    return failClosed(
      'context-rebuild-circuit-breaker-material-published',
      'recognized context-rebuild report occurred after material publication',
      {
        recognizedReport: true,
        failureClass: 'infrastructure',
        evidence: parsedEvidence
      }
    );
  }

  if (materialPublished !== false && hasPatch !== false) {
    return failClosed(
      'material-status-not-trusted-no-patch',
      hasPatch === true
        ? 'worker produced a local patch but authoritative remote publication evidence is unavailable'
        : 'trusted no-published-material evidence is unavailable',
      {
        recognizedReport: true,
        failureClass: 'infrastructure',
        evidence: parsedEvidence
      }
    );
  }

  return Object.freeze({
    recoverable: true,
    recognizedReport: true,
    classification: 'context-rebuild-circuit-breaker',
    reason: 'infrastructure_error',
    failureStage: 'pre-material',
    failureClass: 'infrastructure',
    evidence: parsedEvidence
  });
}

export function classifyPreMaterialWorkerFailure({
  workerConclusion,
  hasPatch,
  materialPublished = null,
  agentOutput,
  authorizationFailure = null
} = {}) {
  if (authorizationFailure?.classification === 'bootstrap-controller-run-mismatch') {
    if (String(workerConclusion ?? '').trim().toLowerCase() !== 'failure') {
      return failClosed(
        'unsupported-worker-conclusion',
        'bootstrap authorization recovery requires terminal worker failure'
      );
    }
    if (hasPatch === true) {
      return failClosed(
        'material-status-not-trusted-no-patch',
        'worker produced material patch before bootstrap authorization recovery'
      );
    }
    return Object.freeze({
      recoverable: true,
      classification: 'bootstrap-controller-run-mismatch',
      reason: 'control-plane-authorization-envelope-mismatch',
      failureStage: 'pre-material',
      failureClass: 'control-plane-authorization',
      retryMode: 'reuse-current-attempt',
      evidence: Object.freeze({
        evidenceRef: String(authorizationFailure.evidenceRef ?? ''),
        activeControllerRunId: Number(authorizationFailure.activeControllerRunId),
        persistedControllerRunId: Number(authorizationFailure.persistedControllerRunId)
      })
    });
  }

  return classifyStructuredContextRebuildFailure({
    workerConclusion,
    hasPatch,
    materialPublished,
    agentOutput
  });
}

export function decidePreMaterialRetry({
  failure,
  currentAttempt,
  maxAttempts
} = {}) {
  const attempt = Number(currentAttempt);
  const ceiling = Number(maxAttempts);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('currentAttempt must be a positive integer');
  }
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (attempt > ceiling) {
    throw new Error('currentAttempt exceeds implementation-attempt ceiling');
  }
  if (!failure?.recoverable) {
    return Object.freeze({ action: 'fail-closed', currentAttempt: attempt, maxAttempts: ceiling });
  }
  if (failure.retryMode === 'reuse-current-attempt') {
    return Object.freeze({
      action: 'retry-same-attempt',
      currentAttempt: attempt,
      nextAttempt: attempt,
      maxAttempts: ceiling
    });
  }
  if (attempt >= ceiling) {
    return Object.freeze({ action: 'budget-exhausted', currentAttempt: attempt, maxAttempts: ceiling });
  }
  return Object.freeze({
    action: 'retry',
    currentAttempt: attempt,
    nextAttempt: attempt + 1,
    maxAttempts: ceiling
  });
}

export function boundedPreMaterialRetryContext({
  failure,
  previousAttempt,
  previousWorkerRunId
} = {}) {
  if (
    !failure?.recoverable
    || !['context-rebuild-circuit-breaker', 'bootstrap-controller-run-mismatch'].includes(failure.classification)
  ) {
    throw new Error('bounded retry context requires a recognized recoverable pre-material failure');
  }
  const attempt = Number(previousAttempt);
  const runId = Number(previousWorkerRunId);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('previousAttempt must be a positive integer');
  if (!Number.isInteger(runId) || runId < 1) throw new Error('previousWorkerRunId must be a positive integer');

  return Object.freeze({
    schemaVersion: 1,
    kind: 'pre-material-retry',
    previousAttempt: attempt,
    previousWorkerRunId: runId,
    failure: Object.freeze({
      classification: failure.classification,
      reason: failure.reason,
      failureStage: failure.failureStage,
      failureClass: failure.failureClass
    })
  });
}
