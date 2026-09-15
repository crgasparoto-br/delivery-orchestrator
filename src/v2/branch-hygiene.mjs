import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NON_TERMINAL = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

function assertOk(response, context) {
  if (!response.ok) throw new Error(`${context}: HTTP ${response.status}`);
  return response;
}

function apiHeaders(token) {
  if (!token) throw new Error('GITHUB_TOKEN is required for branch hygiene');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-orchestrator-branch-hygiene'
  };
}

export function parseRepositoryList(raw) {
  if (!raw || !String(raw).trim()) throw new Error('ORCHESTRATOR_REPOSITORIES is empty');
  const values = String(raw).split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error('ORCHESTRATOR_REPOSITORIES is empty');
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    if (!REPOSITORY_RE.test(value)) throw new Error(`Invalid repository in ORCHESTRATOR_REPOSITORIES: ${value}`);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export function parseOlderThan(value = '7d') {
  const match = /^(\d+)([dh])$/.exec(String(value).trim());
  if (!match) throw new Error('--older-than must use Nd or Nh format');
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('--older-than must be greater than zero');
  return amount * (match[2] === 'd' ? 86_400_000 : 3_600_000);
}

export function createGitHubClient({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const headers = apiHeaders(token);
  const request = async (url, options = {}) => assertOk(await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers } }), `${options.method ?? 'GET'} ${url}`);
  const json = async (url, options) => (await request(url, options)).json();
  const encode = encodeURIComponent;
  return {
    async getRepository(repository) {
      return json(`https://api.github.com/repos/${repository}`);
    },
    async listBranches(repository) {
      const all = [];
      for (let page = 1; ; page += 1) {
        const batch = await json(`https://api.github.com/repos/${repository}/branches?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
    async getBranch(repository, branch) {
      return json(`https://api.github.com/repos/${repository}/branches/${encode(branch)}`);
    },
    async getRules(repository, branch) {
      return json(`https://api.github.com/repos/${repository}/rules/branches/${encode(branch)}`);
    },
    async listOpenPullRequests(repository, branch, owner) {
      return json(`https://api.github.com/repos/${repository}/pulls?state=open&head=${encode(`${owner}:${branch}`)}&per_page=100`);
    },
    async getWorkflowRuns(repository, branch) {
      return json(`https://api.github.com/repos/${repository}/actions/runs?branch=${encode(branch)}&per_page=100`);
    },
    async getCheckRuns(repository, sha) {
      return json(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`);
    },
    async compare(repository, base, head) {
      return json(`https://api.github.com/repos/${repository}/compare/${encode(base)}...${encode(head)}`);
    },
    async deleteBranch(repository, branch) {
      await request(`https://api.github.com/repos/${repository}/git/refs/heads/${encode(branch)}`, { method: 'DELETE' });
    }
  };
}

function gate(name, status, detail = null) {
  return { name, status, detail };
}

function preserve(reason, gates, extra = {}) {
  return { decision: 'preserve', reason, gates, ...extra };
}

function candidate(gates, extra = {}) {
  return { decision: 'candidate', reason: 'all-safety-gates-passed', gates, ...extra };
}

export async function evaluateBranch({ client, repository, repoInfo, branch, branches, olderThanMs, now = Date.now() }) {
  const gates = [];
  const name = branch.name;
  const sha = branch.commit?.sha;
  if (!name || !sha) return preserve('branch-identity-inconclusive', [gate('identity', 'inconclusive')]);
  gates.push(gate('identity', 'pass', sha));
  if (name === repoInfo.default_branch || name === 'main' || name === 'develop') {
    gates.push(gate('reserved-branch', 'block', name));
    return preserve('reserved-branch', gates, { sha });
  }
  gates.push(gate('reserved-branch', 'pass'));

  let fresh;
  try {
    fresh = await client.getBranch(repository, name);
  } catch (error) {
    gates.push(gate('branch-refresh', 'inconclusive', error.message));
    return preserve('branch-refresh-failed', gates, { sha, error: error.message });
  }
  if (fresh.commit?.sha !== sha) {
    gates.push(gate('branch-refresh', 'block', `${sha}->${fresh.commit?.sha ?? 'unknown'}`));
    return preserve('branch-sha-changed', gates, { sha });
  }
  gates.push(gate('branch-refresh', 'pass', sha));
  if (fresh.protected) {
    gates.push(gate('branch-protection', 'block'));
    return preserve('protected-branch', gates, { sha });
  }
  gates.push(gate('branch-protection', 'pass'));

  try {
    const rules = await client.getRules(repository, name);
    if (Array.isArray(rules) && rules.length) {
      gates.push(gate('rulesets', 'block', rules.length));
      return preserve('ruleset-protected', gates, { sha });
    }
    gates.push(gate('rulesets', 'pass'));
  } catch (error) {
    gates.push(gate('rulesets', 'inconclusive', error.message));
    return preserve('rulesets-inconclusive', gates, { sha, error: error.message });
  }

  const committedAt = fresh.commit?.commit?.committer?.date ?? fresh.commit?.commit?.author?.date;
  const ageMs = committedAt ? now - Date.parse(committedAt) : Number.NaN;
  if (!Number.isFinite(ageMs)) {
    gates.push(gate('age', 'inconclusive'));
    return preserve('commit-age-inconclusive', gates, { sha });
  }
  if (ageMs <= olderThanMs) {
    gates.push(gate('age', 'block', ageMs));
    return preserve('branch-too-recent', gates, { sha, committedAt, ageMs });
  }
  gates.push(gate('age', 'pass', ageMs));

  try {
    const prs = await client.listOpenPullRequests(repository, name, repoInfo.owner.login);
    if (prs.length) {
      gates.push(gate('open-pr', 'block', prs.map((pr) => pr.number)));
      return preserve('open-pull-request', gates, { sha, committedAt, ageMs });
    }
    gates.push(gate('open-pr', 'pass'));
  } catch (error) {
    gates.push(gate('open-pr', 'inconclusive', error.message));
    return preserve('open-pr-inconclusive', gates, { sha, committedAt, ageMs, error: error.message });
  }

  try {
    const [workflowPayload, checkPayload] = await Promise.all([
      client.getWorkflowRuns(repository, name),
      client.getCheckRuns(repository, sha)
    ]);
    const activeRuns = (workflowPayload.workflow_runs ?? []).filter((run) => run.head_sha === sha && NON_TERMINAL.has(run.status));
    const activeChecks = (checkPayload.check_runs ?? []).filter((check) => NON_TERMINAL.has(check.status));
    if (activeRuns.length || activeChecks.length) {
      gates.push(gate('active-ci', 'block', { workflows: activeRuns.length, checks: activeChecks.length }));
      return preserve('active-workflow-or-check', gates, { sha, committedAt, ageMs });
    }
    gates.push(gate('active-ci', 'pass'));
  } catch (error) {
    gates.push(gate('active-ci', 'inconclusive', error.message));
    return preserve('ci-state-inconclusive', gates, { sha, committedAt, ageMs, error: error.message });
  }

  const hasDevelop = branches.some((item) => item.name === 'develop');
  const base = hasDevelop ? 'develop' : repoInfo.default_branch;
  try {
    const comparison = await client.compare(repository, base, name);
    if (typeof comparison.ahead_by !== 'number') {
      gates.push(gate('unique-commits', 'inconclusive'));
      return preserve('comparison-inconclusive', gates, { sha, committedAt, ageMs, base });
    }
    if (comparison.ahead_by > 0) {
      gates.push(gate('unique-commits', 'block', comparison.ahead_by));
      return preserve('unique-commits-not-incorporated', gates, { sha, committedAt, ageMs, base });
    }
    gates.push(gate('unique-commits', 'pass', 0));
  } catch (error) {
    gates.push(gate('unique-commits', 'inconclusive', error.message));
    return preserve('comparison-failed', gates, { sha, committedAt, ageMs, base, error: error.message });
  }

  return candidate(gates, { sha, committedAt, ageMs, base });
}

export async function inspectRepository({ client, repository, olderThanMs, now = Date.now() }) {
  let repoInfo;
  let branches;
  try {
    repoInfo = await client.getRepository(repository);
    branches = await client.listBranches(repository);
  } catch (error) {
    return [{ repository, branch: '(repository)', decision: 'doubtful', reason: 'repository-discovery-failed', error: error.message, gates: [] }];
  }
  const records = [];
  for (const branch of branches) {
    const result = await evaluateBranch({ client, repository, repoInfo, branch, branches, olderThanMs, now });
    records.push({ repository, branch: branch.name, ...result });
  }
  return records;
}

function auditDecision(result) {
  if (result.decision === 'candidate') return 'would-remove';
  return result.error || result.gates?.some((item) => item.status === 'inconclusive') ? 'doubtful' : 'preserve';
}

async function writeAudit({ records, logDir, mode, now }) {
  await mkdir(logDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = path.join(logDir, `branch-hygiene-${stamp}.json`);
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, timestamp: new Date(now).toISOString(), mode, records }, null, 2)}\n`, 'utf8');
  return file;
}

export async function acquireRunLock(lockFile) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  try {
    const handle = await open(lockFile, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    return async () => {
      await handle.close();
      await rm(lockFile, { force: true });
    };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`branch hygiene already running: ${lockFile}`);
    throw error;
  }
}

export async function runBranchHygiene({
  repositoriesRaw = process.env.ORCHESTRATOR_REPOSITORIES,
  token = process.env.GITHUB_TOKEN,
  mode = 'dry-run',
  olderThan = '7d',
  logDir = process.env.ORCHESTRATOR_HYGIENE_LOG_DIR ?? path.resolve('var/log/branch-hygiene'),
  lockFile = process.env.ORCHESTRATOR_HYGIENE_LOCK_FILE ?? path.join(tmpdir(), 'delivery-orchestrator-branch-hygiene.lock'),
  client = null,
  now = Date.now()
} = {}) {
  if (!['dry-run', 'apply'].includes(mode)) throw new Error('mode must be dry-run or apply');
  const repositories = parseRepositoryList(repositoriesRaw);
  const olderThanMs = parseOlderThan(olderThan);
  const releaseLock = await acquireRunLock(lockFile);
  try {
    const github = client ?? createGitHubClient({ token });
    const records = [];
    for (const repository of repositories) {
      const initial = await inspectRepository({ client: github, repository, olderThanMs, now });
      for (const record of initial) {
        if (record.decision !== 'candidate') {
          records.push({ ...record, decision: auditDecision(record) });
          continue;
        }
        if (mode === 'dry-run') {
          records.push({ ...record, decision: 'would-remove', reason: 'dry-run-safe-candidate' });
          continue;
        }
        let repoInfo;
        let branches;
        try {
          repoInfo = await github.getRepository(repository);
          branches = await github.listBranches(repository);
          const current = branches.find((item) => item.name === record.branch);
          if (!current || current.commit?.sha !== record.sha) {
            records.push({ ...record, decision: 'preserve', reason: 'toctou-ref-changed' });
            continue;
          }
          const revalidated = await evaluateBranch({ client: github, repository, repoInfo, branch: current, branches, olderThanMs, now });
          if (revalidated.decision !== 'candidate' || revalidated.sha !== record.sha) {
            records.push({ repository, branch: record.branch, ...revalidated, decision: 'preserve', reason: `toctou-${revalidated.reason}` });
            continue;
          }
          await github.deleteBranch(repository, record.branch);
          records.push({ repository, branch: record.branch, ...revalidated, decision: 'removed', reason: 'safe-candidate-revalidated-and-deleted' });
        } catch (error) {
          records.push({ ...record, decision: 'preserve', reason: 'delete-or-revalidation-failed', error: error.message });
        }
      }
    }
    const auditFile = await writeAudit({ records, logDir, mode, now });
    return { mode, olderThan, repositories, records, auditFile };
  } finally {
    await releaseLock();
  }
}

function rows(records) {
  return records.map((item) => `${item.repository}\t${item.branch}\t${item.reason}`);
}

export function formatHumanSummary(result) {
  const removed = result.records.filter((item) => item.decision === 'removed' || item.decision === 'would-remove');
  const preserved = result.records.filter((item) => item.decision === 'preserve');
  const doubtful = result.records.filter((item) => item.decision === 'doubtful');
  const section = (title, items) => [title, 'Repository\tBranch\tReason', ...(items.length ? rows(items) : ['-\t-\t(none)'])].join('\n');
  return [
    section(result.mode === 'dry-run' ? 'Branches removidas (simulação)' : 'Branches removidas', removed),
    section('Branches preservadas por segurança', preserved),
    section('Branches órfãs ou duvidosas', doubtful),
    `JSON audit: ${result.auditFile}`
  ].join('\n\n');
}
