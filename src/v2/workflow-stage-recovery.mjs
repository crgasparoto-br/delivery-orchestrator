import { classifyStructuredContextRebuildFailure } from './pre-material-recovery.mjs';

const RETRYABLE_TERMINAL_CONCLUSIONS = new Set(['timed_out', 'startup_failure']);
const STAGES = new Set([
  'ci-remediation',
  'audit-remediation',
  'technical-hygiene',
  'independent-audit'
]);

function normalizeStage(stage) {
  const value = String(stage ?? '').trim();
  if (!STAGES.has(value)) throw new Error(`unsupported recoverable workflow stage: ${value || '(missing)'}`);
  return value;
}

export function classifyWorkflowStageFailure({
  stage,
  conclusion,
  materialHeadChanged = null,
  hasPatch = null,
  agentOutput = null
} = {}) {
  const normalizedStage = normalizeStage(stage);
  const terminalConclusion = String(conclusion ?? '').trim().toLowerCase();

  if (terminalConclusion === 'success') {
    if (normalizedStage !== 'independent-audit' && hasPatch === false) {
      const structured = classifyStructuredContextRebuildFailure({
        workerConclusion: terminalConclusion,
        hasPatch,
        materialPublished: materialHeadChanged === false
          ? false
          : materialHeadChanged === true
            ? true
            : null,
        agentOutput
      });
      if (structured.recoverable) {
        return Object.freeze({
          ...structured,
          action: 'retry-same-stage',
          stage: normalizedStage
        });
      }
      if (structured.recognizedReport === true) {
        return Object.freeze({
          ...structured,
          action: 'fail-closed',
          stage: normalizedStage
        });
      }
    }
    return Object.freeze({
      recoverable: false,
      action: 'none',
      stage: normalizedStage,
      classification: 'success',
      reason: 'workflow succeeded without a recognized recoverable semantic infrastructure outcome'
    });
  }

  if (materialHeadChanged) {
    return Object.freeze({
      recoverable: false,
      action: 'fail-closed',
      stage: normalizedStage,
      classification: 'material-changed-during-failed-stage',
      reason: 'failed workflow changed the material head; retry would risk duplicating or masking partial work'
    });
  }

  if (RETRYABLE_TERMINAL_CONCLUSIONS.has(terminalConclusion)) {
    return Object.freeze({
      recoverable: true,
      action: 'retry-same-stage',
      stage: normalizedStage,
      classification: `workflow-${terminalConclusion}`,
      reason: terminalConclusion,
      failureClass: 'infrastructure'
    });
  }

  if (terminalConclusion === 'failure' && normalizedStage !== 'independent-audit') {
    const structured = classifyStructuredContextRebuildFailure({
      workerConclusion: terminalConclusion,
      hasPatch,
      materialPublished: materialHeadChanged === false
        ? false
        : materialHeadChanged === true
          ? true
          : null,
      agentOutput
    });
    if (structured.recoverable) {
      return Object.freeze({
        ...structured,
        action: 'retry-same-stage',
        stage: normalizedStage
      });
    }
  }

  return Object.freeze({
    recoverable: false,
    action: 'fail-closed',
    stage: normalizedStage,
    classification: terminalConclusion
      ? `workflow-${terminalConclusion}-not-retryable`
      : 'workflow-conclusion-missing',
    reason: terminalConclusion
      ? 'workflow conclusion is not in the deterministic infrastructure retry allowlist'
      : 'workflow conclusion is unavailable'
  });
}

export function decideWorkflowStageRetry({
  failure,
  retriesUsed = 0,
  maxRetries = 1
} = {}) {
  const used = Number(retriesUsed);
  const ceiling = Number(maxRetries);
  if (!Number.isInteger(used) || used < 0) throw new Error('retriesUsed must be a non-negative integer');
  if (!Number.isInteger(ceiling) || ceiling < 0) throw new Error('maxRetries must be a non-negative integer');

  if (!failure?.recoverable || failure?.action !== 'retry-same-stage') {
    return Object.freeze({ action: 'fail-closed', retriesUsed: used, maxRetries: ceiling });
  }
  if (used >= ceiling) {
    return Object.freeze({ action: 'retry-budget-exhausted', retriesUsed: used, maxRetries: ceiling });
  }
  return Object.freeze({
    action: 'retry-same-stage',
    retriesUsed: used,
    nextRetriesUsed: used + 1,
    maxRetries: ceiling
  });
}
