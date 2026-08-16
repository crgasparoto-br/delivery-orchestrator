const DEFAULT_API_URL = 'https://api.github.com';

function splitRepository(repository) {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error('repository must be owner/repo');
  }
  return parts;
}

function normalizeRun(run) {
  return {
    id: run.id,
    name: run.name,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion ?? null,
    head_sha: run.head_sha,
    html_url: run.html_url ?? null,
    created_at: run.created_at ?? null,
    updated_at: run.updated_at ?? null
  };
}

export async function listExactHeadWorkflowRuns({
  repository,
  sha,
  token,
  fetchImpl = globalThis.fetch,
  apiUrl = DEFAULT_API_URL
}) {
  if (!token) throw new Error('DELIVERY_GITHUB_READ_TOKEN is required for CI observation');
  if (!sha) throw new Error('handoff SHA is required for CI observation');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required for CI observation');

  const [owner, repo] = splitRepository(repository);
  const url = new URL(`${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`);
  url.searchParams.set('head_sha', sha);
  url.searchParams.set('per_page', '100');

  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'delivery-orchestrator'
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const suffix = body ? `: ${body.slice(0, 300)}` : '';
    throw new Error(`GitHub Actions observation failed (${response.status})${suffix}`);
  }
  const payload = await response.json();
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  return runs.filter((run) => run.head_sha === sha).map(normalizeRun);
}

function runSetSignature(runs) {
  return runs.map((run) => String(run.id)).sort().join(',');
}

function summarize(runs) {
  return runs.map(({ id, name, event, status, conclusion, head_sha, html_url }) => ({
    id, name, event, status, conclusion, head_sha, html_url
  }));
}

export async function waitForExactHeadWorkflowRuns({
  repository,
  sha,
  token,
  fetchImpl = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = () => Date.now(),
  discoveryGraceMs = 30_000,
  pollIntervalMs = 15_000,
  settleMs = 15_000,
  timeoutMs = 30 * 60_000
}) {
  const startedAt = nowFn();
  let polls = 0;
  let lastRuns = [];
  let terminalSignature = null;
  let terminalSince = null;

  while (true) {
    lastRuns = await listExactHeadWorkflowRuns({ repository, sha, token, fetchImpl });
    polls += 1;
    const now = nowFn();
    const elapsedMs = now - startedAt;

    if (lastRuns.length === 0) {
      terminalSignature = null;
      terminalSince = null;
      if (elapsedMs >= discoveryGraceMs) {
        return {
          status: 'no-runs',
          repository,
          sha,
          polls,
          elapsed_ms: elapsedMs,
          runs: []
        };
      }
    } else if (lastRuns.every((run) => run.status === 'completed')) {
      const signature = runSetSignature(lastRuns);
      if (terminalSignature !== signature) {
        terminalSignature = signature;
        terminalSince = now;
      } else if (terminalSince !== null && now - terminalSince >= settleMs) {
        return {
          status: 'terminal',
          repository,
          sha,
          polls,
          elapsed_ms: elapsedMs,
          runs: summarize(lastRuns)
        };
      }
    } else {
      terminalSignature = null;
      terminalSince = null;
    }

    if (elapsedMs >= timeoutMs) {
      return {
        status: 'timeout',
        repository,
        sha,
        polls,
        elapsed_ms: elapsedMs,
        runs: summarize(lastRuns)
      };
    }

    await sleepFn(pollIntervalMs);
  }
}
