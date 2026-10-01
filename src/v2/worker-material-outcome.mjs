const NO_MATERIAL_SAFE_OUTPUT_TYPES = new Set([
  'missing_tool',
  'missing_data',
  'noop',
  'report_incomplete'
]);

function normalizedAgentOutput(agentOutput) {
  const errors = Array.isArray(agentOutput?.errors) ? agentOutput.errors.filter(Boolean) : null;
  const items = Array.isArray(agentOutput?.items) ? agentOutput.items : null;
  return { errors, items };
}

export function classifySuccessfulWorkerOutcome({
  hasPatch,
  agentOutput,
  evidenceRef = null,
  artifactError = null
} = {}) {
  const { errors, items } = normalizedAgentOutput(agentOutput);

  if (!errors || !items || errors.length > 0) {
    return Object.freeze({
      action: 'fail-closed',
      classification: 'material-evidence-ambiguous',
      reason: errors?.length
        ? 'successful worker reported framework errors; material completion is not trusted'
        : String(artifactError ?? 'successful worker did not provide a valid agent_output envelope'),
      evidenceRef
    });
  }

  if (hasPatch === true) {
    return Object.freeze({
      action: 'await-material-head',
      classification: 'patch-produced',
      reason: 'worker artifact contains a material patch; repository effect must still be observed',
      evidenceRef
    });
  }

  if (hasPatch !== false) {
    return Object.freeze({
      action: 'fail-closed',
      classification: 'material-evidence-ambiguous',
      reason: String(artifactError ?? 'successful worker did not provide deterministic patch evidence'),
      evidenceRef
    });
  }

  if (items.length === 0) {
    return Object.freeze({
      action: 'fail-closed',
      classification: 'no-patch-output-ambiguous',
      reason: 'successful worker produced no material patch and no trusted semantic safe-output item',
      evidenceRef
    });
  }

  const itemTypes = [...new Set(items.map((item) => String(item?.type ?? '').trim()).filter(Boolean))];
  if (itemTypes.length === 0 || itemTypes.some((type) => !NO_MATERIAL_SAFE_OUTPUT_TYPES.has(type))) {
    return Object.freeze({
      action: 'fail-closed',
      classification: 'no-patch-output-unsupported',
      reason: 'successful worker produced no patch with a safe output that cannot prove material completion',
      evidenceRef
    });
  }

  const primary = items[0] ?? {};
  return Object.freeze({
    action: 'blocked-no-material',
    classification: `no-material-${itemTypes.join('+')}`,
    reason: String(primary.reason ?? primary.message ?? 'worker completed without a material patch'),
    ...(primary.tool ? { tool: String(primary.tool) } : {}),
    evidenceRef
  });
}

export async function continueAfterSuccessfulWorkerOutcome({
  evidence,
  waitForMaterialHead
} = {}) {
  const workerEvidence = evidence ?? {};
  const workerOutcome = classifySuccessfulWorkerOutcome({
    ...workerEvidence,
    artifactError: workerEvidence.artifactError ?? workerEvidence.error ?? null
  });

  if (workerOutcome.action !== 'await-material-head') {
    return Object.freeze({ workerOutcome, remediationOutcome: workerOutcome, pullRequest: null });
  }

  if (typeof waitForMaterialHead !== 'function') {
    throw new Error('successful worker with a material patch requires a material-effect waiter');
  }

  return Object.freeze({
    workerOutcome,
    remediationOutcome: workerOutcome,
    pullRequest: await waitForMaterialHead()
  });
}

export const classifySuccessfulRemediationOutcome = classifySuccessfulWorkerOutcome;
export const continueAfterSuccessfulRemediation = continueAfterSuccessfulWorkerOutcome;
