import test from 'node:test';
import assert from 'node:assert/strict';

// This is a structural test: the real loop is integration-tested in GitHub Actions where gh/Codex are available.
test('structured result contract requires independent release gate for completion', async () => {
  const { AUDIT_RESULT_SCHEMA } = await import('../src/schemas.mjs');
  assert.ok(AUDIT_RESULT_SCHEMA.properties.validity.enum.includes('independent'));
  assert.equal(AUDIT_RESULT_SCHEMA.properties.release_gate_satisfied.type, 'boolean');
});

test('auditor workspace guard rejects local candidate mutation', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runCommand } = await import('../src/process.mjs');
  const { verifyAuditWorkspaceClean } = await import('../src/git-workspace.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delivery-orchestrator-test-'));
  await runCommand('git', ['init'], { cwd: dir });
  await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runCommand('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'candidate.txt'), 'clean\n');
  await runCommand('git', ['add', 'candidate.txt'], { cwd: dir });
  await runCommand('git', ['commit', '-m', 'candidate'], { cwd: dir });
  const expectedHead = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  assert.deepEqual(await verifyAuditWorkspaceClean({ cwd: dir, expectedHead }), { head: expectedHead, clean: true });
  await writeFile(path.join(dir, 'candidate.txt'), 'mutated\n');
  await assert.rejects(() => verifyAuditWorkspaceClean({ cwd: dir, expectedHead }), /Auditor modified the candidate workspace/);
});


test('sandbox mode is explicit and rejects invalid values', async () => {
  const { resolveSandboxMode } = await import('../src/config.mjs');
  assert.equal(resolveSandboxMode(undefined), 'workspace-write');
  assert.equal(resolveSandboxMode('danger-full-access'), 'danger-full-access');
  assert.equal(resolveSandboxMode('read-only'), 'read-only');
  assert.throws(() => resolveSandboxMode('unsafe-magic'), /CODEX_SANDBOX_MODE must be one of/);
});

test('exact-head CI wait observes pending runs until the stable run set is terminal', async () => {
  const { waitForExactHeadWorkflowRuns } = await import('../src/github-ci.mjs');
  let now = 0;
  const responses = [
    [{ id: 1, name: 'gate', event: 'pull_request', status: 'in_progress', conclusion: null, head_sha: 'abc' }],
    [{ id: 1, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' }],
    [{ id: 1, name: 'gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' }]
  ];
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ workflow_runs: responses.shift() ?? [] })
  });
  const result = await waitForExactHeadWorkflowRuns({
    repository: 'owner/repo',
    sha: 'abc',
    token: 'read-token',
    fetchImpl,
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    discoveryGraceMs: 10,
    pollIntervalMs: 10,
    settleMs: 10,
    timeoutMs: 100
  });
  assert.equal(result.status, 'terminal');
  assert.equal(result.polls, 3);
  assert.equal(result.runs[0].conclusion, 'success');
});

test('exact-head CI wait proceeds after discovery grace when no workflow applies', async () => {
  const { waitForExactHeadWorkflowRuns } = await import('../src/github-ci.mjs');
  let now = 0;
  const result = await waitForExactHeadWorkflowRuns({
    repository: 'owner/repo',
    sha: 'abc',
    token: 'read-token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) }),
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    discoveryGraceMs: 10,
    pollIntervalMs: 10,
    settleMs: 10,
    timeoutMs: 100
  });
  assert.equal(result.status, 'no-runs');
  assert.equal(result.polls, 2);
});


test('exact-head CI wait catches a workflow that appears during the settle window', async () => {
  const { waitForExactHeadWorkflowRuns } = await import('../src/github-ci.mjs');
  let now = 0;
  const responses = [
    [{ id: 1, name: 'fast-gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' }],
    [
      { id: 1, name: 'fast-gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' },
      { id: 2, name: 'late-gate', event: 'pull_request', status: 'in_progress', conclusion: null, head_sha: 'abc' }
    ],
    [
      { id: 1, name: 'fast-gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' },
      { id: 2, name: 'late-gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' }
    ],
    [
      { id: 1, name: 'fast-gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' },
      { id: 2, name: 'late-gate', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' }
    ]
  ];
  const result = await waitForExactHeadWorkflowRuns({
    repository: 'owner/repo',
    sha: 'abc',
    token: 'read-token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ workflow_runs: responses.shift() ?? [] }) }),
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    discoveryGraceMs: 0,
    pollIntervalMs: 10,
    settleMs: 10,
    timeoutMs: 100
  });
  assert.equal(result.status, 'terminal');
  assert.equal(result.polls, 4);
  assert.deepEqual(result.runs.map((run) => run.name).sort(), ['fast-gate', 'late-gate']);
});

test('exact-head CI wait times out instead of auditing a perpetually pending head', async () => {
  const { waitForExactHeadWorkflowRuns } = await import('../src/github-ci.mjs');
  let now = 0;
  const result = await waitForExactHeadWorkflowRuns({
    repository: 'owner/repo',
    sha: 'abc',
    token: 'read-token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ workflow_runs: [
      { id: 1, name: 'gate', event: 'pull_request', status: 'in_progress', conclusion: null, head_sha: 'abc' }
    ] }) }),
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    discoveryGraceMs: 0,
    pollIntervalMs: 10,
    settleMs: 10,
    timeoutMs: 20
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.polls, 3);
  assert.equal(result.runs[0].status, 'in_progress');
});
