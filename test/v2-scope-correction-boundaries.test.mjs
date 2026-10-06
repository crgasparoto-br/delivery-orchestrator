import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectMaterialScopeGuardFailure,
  observeScopeCorrectionPublication,
  persistReentryMutation,
  rearmLegacyNonrecoverableBootstrapLease,
  recoveryContextForScopeCorrection as recover
} from '../scripts/guard-delivery-v2-reentry.mjs';
import { createWorkerScopeBinding } from '../.github/scripts/delivery-v2-worker-scope-contract.mjs';
import { hasPublishedPullRequestForIssue, selectExistingPullRequest } from '../src/v2/controller-provenance.mjs';

function fixture() {
  const repository = 'owner/repo';
  const issue = { number: 63, title: 'Scope correction', body: 'Same contract' };
  const changedPaths = ['src/a.mjs', 'src/b.mjs'];
  return {
    bootstrapLease: {
      schemaVersion: 1, repository, issueNumber: issue.number, baseBranch: 'main', provider: 'codex',
      controllerRunId: 41, controllerHeadSha: 'a'.repeat(40), implementationAttempts: 1,
      status: 'escalated-initial-nonrecoverable',
      scopeBinding: createWorkerScopeBinding({ repository, issue, authorizedPaths: ['src/a.mjs'] }),
      lastFailure: { workerRunId: 388, hasPatch: true, failureStage: 'pre-material', materialPublished: false }
    },
    scopeGuardFailure: { classification: 'material-scope-guard-rejected-local-patch', workerRunId: 388 },
    observedPatch: { hasPatch: true, materialPublished: false, changedPaths },
    correctedScopeBinding: createWorkerScopeBinding({ repository, issue, authorizedPaths: changedPaths })
  };
}

async function observe(pulls) {
  const requested = [];
  const materialPublished = await observeScopeCorrectionPublication({
    repository: 'owner/repo', issueNumber: 63, token: 'fixture',
    read: async (url) => {
      requested.push(url);
      const query = new URL(url).searchParams;
      assert.equal(query.get('state'), 'all');
      const page = Number(query.get('page'));
      return pulls.slice((page - 1) * 100, page * 100);
    }
  });
  return { materialPublished, requested };
}

for (const [name, state, merged_at] of [
  ['open', 'open', null], ['closed', 'closed', null], ['merged', 'closed', '2026-10-01T00:00:00Z']
]) {
  test(`historical ${name} publication blocks recovery and every write`, async () => {
    const f = fixture();
    const observation = await observe([{ number: 100, state, merged_at, body: 'Closes #63' }]);
    f.observedPatch.materialPublished = observation.materialPublished;
    assert.equal(recover(f), null);
    let writes = 0;
    const mutated = await persistReentryMutation({
      decision: { status: 'escalated-initial-nonrecoverable', runController: false },
      bootstrapLease: f.bootstrapLease, repository: 'owner/repo',
      getWriteToken: () => { throw new Error('denial must not resolve write capability'); },
      mutate: async () => { writes += 1; }
    });
    assert.equal(mutated, false);
    assert.equal(writes, 0);
  });
}

test('absence of historical publication preserves a single replacement attempt and provenance', async () => {
  const f = fixture();
  f.observedPatch.materialPublished = (await observe([])).materialPublished;
  const before = structuredClone(f);
  const recovery = recover(f);
  assert.equal(recovery.retryMode, 'reuse-current-attempt');
  assert.equal(recovery.grantedImplementationAttempts, 0);
  const decision = { recovery, dispatchNonce: 'corrected-nonce' };
  const rearmed = rearmLegacyNonrecoverableBootstrapLease(f.bootstrapLease, decision, {
    currentControllerRunId: 42, currentControllerHeadSha: 'b'.repeat(40)
  });
  assert.equal(rearmed.implementationAttempts, 1);
  assert.equal(rearmed.status, 'reserved-initial-attempt');
  assert.equal(rearmed.dispatchNonce, 'corrected-nonce');
  assert.equal(rearmed.workerRunId, null);
  assert.deepEqual(rearmed.recovery.previousFailure, f.bootstrapLease.lastFailure);
  assert.deepEqual(rearmed.scopeBinding, f.correctedScopeBinding);
  assert.deepEqual(rearmed.recovery.previousScopeBinding, f.bootstrapLease.scopeBinding);
  assert.deepEqual(f, before);
  assert.equal(recover({ ...f, bootstrapLease: rearmed }), null);
});

test('historical publication on a later page cannot disappear from eligibility', async () => {
  const pulls = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, body: 'Unrelated work', state: 'closed' }));
  pulls.push({ number: 101, body: 'Fixes owner/repo#63', state: 'closed', head: null });
  const observed = await observe(pulls);
  assert.equal(observed.materialPublished, true);
  assert.equal(observed.requested.length, 2);
});

test('publication uses canonical closing relationships without requiring a live head, author or original base', async () => {
  const observed = await observe([{ number: 100, state: 'closed', head: null, base: { ref: 'other' }, body: 'Resolves https://github.com/owner/repo/issues/63' }]);
  assert.equal(observed.materialPublished, true);
  assert.equal((await observe([{ body: 'Closes other/repo#63' }, { body: 'Closes #64' }])).materialPublished, false);
  assert.equal(hasPublishedPullRequestForIssue([{ body: 'Closes #63 and fixes #64' }, { body: 'Closes #63' }], { repository: 'owner/repo', issueNumber: 63 }), true);
});

test('quoted, hidden and code-only closing text is not promoted into publication evidence', async () => {
  assert.equal((await observe([
    { body: '<!-- Closes #63 -->' }, { body: '> Closes #63' },
    { body: '```text\nCloses #63\n```' }, { body: '`Fixes #63`' }, { body: null }
  ])).materialPublished, false);
});

for (const [name, response] of [['object', {}], ['null', null], ['incomplete PR', [{}]]]) {
  test(`unavailable or malformed publication evidence fails closed: ${name}`, async () => {
    await assert.rejects(observeScopeCorrectionPublication({
      repository: 'owner/repo', issueNumber: 63, token: 'fixture', read: async () => response
    }));
  });
}

test('an API failure while collecting historical publication never becomes absence', async () => {
  await assert.rejects(observeScopeCorrectionPublication({
    repository: 'owner/repo', issueNumber: 63, token: 'fixture',
    read: async () => { throw new Error('fixture API unavailable'); }
  }), /fixture API unavailable/);
});

test('the adoption selector continues to reject a closed PR rather than adopting historical material', () => {
  assert.throws(() => selectExistingPullRequest([{ body: 'Closes #63', state: 'closed' }], {
    repository: 'owner/repo', issueNumber: 63, baseBranch: 'main', trustedLogin: 'owner'
  }), /explicit open state/);
});

for (const stage of [undefined, null, 'post-material', 'unknown', '']) {
  test(`only explicit pre-material phase may recover or collect scope evidence: ${String(stage)}`, async () => {
    const f = fixture();
    f.bootstrapLease.lastFailure.failureStage = stage;
    assert.equal(recover(f), null);
    let reads = 0;
    const detected = await detectMaterialScopeGuardFailure({
      bootstrapLease: f.bootstrapLease,
      recoveredWorkerRun: { id: 388, status: 'completed', conclusion: 'failure' },
      orchestratorRepository: 'owner/orchestrator', actionsToken: 'fixture',
      listJobs: async () => { reads += 1; return []; }
    });
    assert.equal(detected, null);
    assert.equal(reads, 0);
  });
}

for (const [name, mutate] of [
  ['unknown enforcement', (b) => { b.enforcement = 'unknown'; }],
  ['missing paths', (b) => { delete b.authorizedPaths; }],
  ['traversal path', (b) => { b.authorizedPaths = ['../outside']; }],
  ['empty paths', (b) => { b.authorizedPaths = []; }],
  ['non-array paths', (b) => { b.authorizedPaths = 'src/a.mjs'; }],
  ['invalid schema', (b) => { b.schemaVersion = 2; }],
  ['issue-only authorization', (b) => { b.enforcement = 'issue-contract-only'; }],
  ['invalid fingerprint', (b) => { b.issueContractSha256 = 'not-a-fingerprint'; }],
  ['other repository', (b) => { b.repository = 'other/repo'; }],
  ['other issue', (b) => { b.issueNumber = 64; }]
]) {
  test(`invalid prior binding never proves a scope rejection: ${name}`, () => {
    const f = fixture();
    f.bootstrapLease.scopeBinding = { ...f.bootstrapLease.scopeBinding };
    mutate(f.bootstrapLease.scopeBinding);
    assert.equal(recover(f), null);
  });
}

test('valid but already sufficient old scope is not a correction', () => {
  const f = fixture();
  f.bootstrapLease.scopeBinding = { ...f.bootstrapLease.scopeBinding, authorizedPaths: ['src/'] };
  assert.equal(recover(f), null);
});

test('corrected scope must cover every patch path and respect directory boundaries', () => {
  const f = fixture();
  f.correctedScopeBinding = { ...f.correctedScopeBinding, authorizedPaths: ['src/a.mjs'] };
  assert.equal(recover(f), null);
  f.correctedScopeBinding.authorizedPaths = ['src/'];
  f.observedPatch.changedPaths.push('src-other/c.mjs');
  assert.equal(recover(f), null);
});

for (const attempts of [undefined, 0, -1, 1.5]) {
  test(`invalid attempt counter cannot authorize a replacement: ${String(attempts)}`, () => {
    const f = fixture();
    f.bootstrapLease.implementationAttempts = attempts;
    assert.equal(recover(f), null);
  });
}

test('persisted publication cannot be contradicted by a later negative observation', () => {
  const f = fixture();
  f.bootstrapLease.lastFailure.materialPublished = true;
  assert.equal(recover(f), null);
});
