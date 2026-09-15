import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRepositoryList, runBranchHygiene } from '../src/v2/branch-hygiene.mjs';

const OLD = '2026-08-01T00:00:00Z';
const NOW = Date.parse('2026-09-15T20:00:00Z');

function fakeClient(overrides = {}) {
  const deleted = [];
  const state = {
    repo: { default_branch: 'main', owner: { login: 'owner' } },
    branches: [
      { name: 'main', commit: { sha: 'mainsha' } },
      { name: 'develop', commit: { sha: 'devsha' } },
      { name: 'feature/old', commit: { sha: 'oldsha' } }
    ],
    branch: {
      name: 'feature/old',
      protected: false,
      commit: { sha: 'oldsha', commit: { committer: { date: OLD } } }
    }
  };
  const client = {
    deleted,
    async getRepository() { return state.repo; },
    async listBranches() { return structuredClone(state.branches); },
    async getBranch(_repo, name) {
      if (name === 'main') return { name, protected: false, commit: { sha: 'mainsha', commit: { committer: { date: OLD } } } };
      if (name === 'develop') return { name, protected: false, commit: { sha: 'devsha', commit: { committer: { date: OLD } } } };
      return structuredClone(state.branch);
    },
    async getRules() { return []; },
    async listOpenPullRequests() { return []; },
    async getWorkflowRuns() { return { workflow_runs: [] }; },
    async getCheckRuns() { return { check_runs: [] }; },
    async compare() { return { ahead_by: 0 }; },
    async deleteBranch(repo, branch) { deleted.push(`${repo}:${branch}`); }
  };
  return Object.assign(client, overrides);
}

async function tempPaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'branch-hygiene-test-'));
  return { logDir: path.join(root, 'logs'), lockFile: path.join(root, 'run.lock') };
}

test('parses only repositories from ORCHESTRATOR_REPOSITORIES syntax and deduplicates', () => {
  assert.deepEqual(parseRepositoryList('acme/one, acme/two, ACME/one'), ['acme/one', 'acme/two']);
  assert.throws(() => parseRepositoryList(''), /empty/);
  assert.throws(() => parseRepositoryList('acme'), /Invalid repository/);
  assert.throws(() => parseRepositoryList('https:\/\/github.com\/acme\/one'), /Invalid repository/);
});

test('dry-run never mutates and reports safe candidate', async () => {
  const paths = await tempPaths();
  const client = fakeClient();
  const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client, mode: 'dry-run', olderThan: '7d', now: NOW, ...paths });
  assert.deepEqual(client.deleted, []);
  assert.equal(result.records.find((item) => item.branch === 'feature/old').decision, 'would-remove');
  assert.match(await readFile(result.auditFile, 'utf8'), /dry-run-safe-candidate/);
});

test('apply removes only old fully incorporated branch after revalidation', async () => {
  const paths = await tempPaths();
  const client = fakeClient();
  const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client, mode: 'apply', olderThan: '7d', now: NOW, ...paths });
  assert.deepEqual(client.deleted, ['acme/project:feature/old']);
  assert.equal(result.records.find((item) => item.branch === 'feature/old').decision, 'removed');
});

test('preserves default, main and develop', async () => {
  const paths = await tempPaths();
  const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client: fakeClient(), mode: 'dry-run', now: NOW, ...paths });
  for (const name of ['main', 'develop']) assert.equal(result.records.find((item) => item.branch === name).decision, 'preserve');
});

test('preserves recent branch', async () => {
  const paths = await tempPaths();
  const client = fakeClient({ async getBranch(_repo, name) {
    if (name !== 'feature/old') return { name, protected: false, commit: { sha: `${name}sha`, commit: { committer: { date: OLD } } } };
    return { name, protected: false, commit: { sha: 'oldsha', commit: { committer: { date: '2026-09-14T00:00:00Z' } } } };
  } });
  const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client, mode: 'dry-run', now: NOW, ...paths });
  assert.equal(result.records.find((item) => item.branch === 'feature/old').reason, 'branch-too-recent');
});

test('preserves protected branch and ruleset-protected branch', async () => {
  const one = await tempPaths();
  const protectedClient = fakeClient({ async getBranch(_repo, name) {
    if (name !== 'feature/old') return { name, protected: false, commit: { sha: `${name}sha`, commit: { committer: { date: OLD } } } };
    return { name, protected: true, commit: { sha: 'oldsha', commit: { committer: { date: OLD } } } };
  } });
  const protectedResult = await runBranchHygiene({ repositoriesRaw: 'acme/project', client: protectedClient, now: NOW, ...one });
  assert.equal(protectedResult.records.find((item) => item.branch === 'feature/old').reason, 'protected-branch');

  const two = await tempPaths();
  const rulesClient = fakeClient({ async getRules(_repo, branch) { return branch === 'feature/old' ? [{ type: 'deletion' }] : []; } });
  const rulesResult = await runBranchHygiene({ repositoriesRaw: 'acme/project', client: rulesClient, now: NOW, ...two });
  assert.equal(rulesResult.records.find((item) => item.branch === 'feature/old').reason, 'ruleset-protected');
});

test('preserves open PR, active workflow/check and unique commits', async () => {
  for (const scenario of [
    { override: { async listOpenPullRequests(_r, branch) { return branch === 'feature/old' ? [{ number: 7 }] : []; } }, reason: 'open-pull-request' },
    { override: { async getWorkflowRuns(_r, branch) { return { workflow_runs: branch === 'feature/old' ? [{ head_sha: 'oldsha', status: 'in_progress' }] : [] }; } }, reason: 'active-workflow-or-check' },
    { override: { async compare(_r, _base, head) { return { ahead_by: head === 'feature/old' ? 1 : 0 }; } }, reason: 'unique-commits-not-incorporated' }
  ]) {
    const paths = await tempPaths();
    const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client: fakeClient(scenario.override), now: NOW, ...paths });
    assert.equal(result.records.find((item) => item.branch === 'feature/old').reason, scenario.reason);
  }
});

test('any API uncertainty preserves branch and marks doubtful', async () => {
  const paths = await tempPaths();
  const client = fakeClient({ async getRules(_repo, branch) { if (branch === 'feature/old') throw new Error('403'); return []; } });
  const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client, now: NOW, ...paths });
  const record = result.records.find((item) => item.branch === 'feature/old');
  assert.equal(record.decision, 'doubtful');
  assert.equal(record.reason, 'rulesets-inconclusive');
});

test('SHA change between evaluation and apply preserves branch', async () => {
  const paths = await tempPaths();
  const client = fakeClient();
  let listings = 0;
  client.listBranches = async () => {
    listings += 1;
    const branches = [
      { name: 'main', commit: { sha: 'mainsha' } },
      { name: 'develop', commit: { sha: 'devsha' } },
      { name: 'feature/old', commit: { sha: listings >= 2 ? 'changedsha' : 'oldsha' } }
    ];
    return branches;
  };
  const result = await runBranchHygiene({ repositoriesRaw: 'acme/project', client, mode: 'apply', now: NOW, ...paths });
  assert.deepEqual(client.deleted, []);
  assert.equal(result.records.find((item) => item.branch === 'feature/old').reason, 'toctou-ref-changed');
});

test('two concurrent executions are mutually exclusive', async () => {
  const paths = await tempPaths();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const client = fakeClient({ async getRepository() { await blocked; return { default_branch: 'main', owner: { login: 'owner' } }; } });
  const first = runBranchHygiene({ repositoriesRaw: 'acme/project', client, now: NOW, ...paths });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(() => runBranchHygiene({ repositoriesRaw: 'acme/project', client: fakeClient(), now: NOW, ...paths }), /already running/);
  release();
  await first;
});

test('multiple configured repositories are processed without token-based discovery', async () => {
  const paths = await tempPaths();
  const seen = [];
  const client = fakeClient({ async getRepository(repo) { seen.push(repo); return { default_branch: 'main', owner: { login: repo.split('/')[0] } }; } });
  const result = await runBranchHygiene({ repositoriesRaw: 'org/a,org/b', client, now: NOW, ...paths });
  assert.deepEqual(result.repositories, ['org/a', 'org/b']);
  assert.deepEqual([...new Set(seen)].sort(), ['org/a', 'org/b']);
});
