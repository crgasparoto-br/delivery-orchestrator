export const DELIVERY_REQUEST_PREFIX = 'delivery-request:';
export const LIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export function isQueuedControlIssue(issue) {
  return Boolean(
    issue &&
    issue.state === 'open' &&
    !issue.pull_request &&
    String(issue.title ?? '').startsWith(DELIVERY_REQUEST_PREFIX)
  );
}

export function selectOldestQueuedControlIssue(issues, { excludeIssueNumbers = [] } = {}) {
  const excluded = new Set(excludeIssueNumbers.map(Number));
  return [...issues]
    .filter(isQueuedControlIssue)
    .filter((issue) => !excluded.has(Number(issue.number)))
    .sort((a, b) => {
      const byCreated = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
      return byCreated || Number(a.number) - Number(b.number);
    })[0] ?? null;
}

export function otherLiveWorkflowRuns(runs, currentRunId) {
  const current = Number(currentRunId);
  return [...runs].filter((run) => Number(run.id) !== current && LIVE_RUN_STATUSES.has(String(run.status)));
}
