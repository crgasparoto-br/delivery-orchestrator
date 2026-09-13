const RUN_URL_RE = /\/actions\/runs\/(\d+)(?:\/|$)/;

function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function requiredSha(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${label} must be a 40-character Git SHA`);
  return result;
}

export function workflowRunIdFromCheck(check) {
  const match = String(check?.details_url ?? '').match(RUN_URL_RE);
  return match ? requiredPositiveInteger(match[1], 'workflow run id from check') : null;
}

export function selectAuthoritativeSourceWorkflowRun(runs, { workflowName, sha } = {}) {
  if (!Array.isArray(runs)) throw new Error('workflow runs must be an array');
  const expectedName = String(workflowName ?? '').trim();
  if (!expectedName) throw new Error('workflowName is required');
  const expectedSha = requiredSha(sha, 'sha');
  const matches = runs.filter((run) =>
    String(run?.name ?? '') === expectedName
    && String(run?.event ?? '') === 'pull_request'
    && String(run?.head_sha ?? '').toLowerCase() === expectedSha
  ).sort((a, b) => Number(b?.run_number ?? 0) - Number(a?.run_number ?? 0) || Number(b?.id ?? 0) - Number(a?.id ?? 0));
  return matches[0] ?? null;
}

export function selectCheckForWorkflowRun(checks, { requiredStatusName, workflowRunId } = {}) {
  if (!Array.isArray(checks)) throw new Error('check runs must be an array');
  const expectedName = String(requiredStatusName ?? '').trim();
  if (!expectedName) throw new Error('requiredStatusName is required');
  const expectedRunId = requiredPositiveInteger(workflowRunId, 'workflowRunId');
  const matches = checks.filter((check) => String(check?.name ?? '') === expectedName && workflowRunIdFromCheck(check) === expectedRunId);
  if (matches.length > 1) throw new Error(`ambiguous required check ${expectedName} for workflow run ${expectedRunId}`);
  return matches[0] ?? null;
}
