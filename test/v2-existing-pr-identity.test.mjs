import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateReentry, parsePersistentStateEnvelope, selectManagedPullRequest } from '../scripts/guard-delivery-v2-reentry.mjs';
import { selectExistingPullRequest } from '../src/v2/controller-provenance.mjs';
import { operationalStateFromPersistent, evaluateOperationalRelease } from '../src/v2/operational-controller.mjs';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/issue-105-existing-pr.json', import.meta.url), 'utf8'));
const { pullRequest, stateEnvelope, stateComment } = snapshot.issue105;
const options = { repository: 'crgasparoto-br/delivery-orchestrator', issueNumber: 105, baseBranch: 'main', trustedLogin: 'crgasparoto-br' };
const reentry = (pr = pullRequest, envelope = stateEnvelope) => evaluateReentry({
  pullRequest: pr, stateEnvelope: envelope, targetRepository: options.repository,
  issueNumber: 105, baseBranch: 'main', provider: 'codex', model: 'gpt-5.6-sol'
});

test('issue #105 / PR #122 preserves the real PR, branch, head, rejected audit and all counters', () => {
  const selected = selectManagedPullRequest([pullRequest], options);
  const parsed = parsePersistentStateEnvelope([{
    ...stateComment,
    body: `<!-- delivery-v2-state -->\n\`\`\`json\n${JSON.stringify(stateEnvelope)}\n\`\`\``
  }], options);
  const decision = reentry(selected, parsed);
  assert.equal(decision.resumePr, 122);
  assert.equal(decision.materialHeadSha, 'ed6dfdc35b59853ae65a135b7ecfb49a71c859a3');
  assert.equal(selected.head.ref, 'delivery-v2/issue-105-adopt-legacy-pr-36d627ccc040f749');
  assert.deepEqual(decision.attempts, { implementation: 3, audit: 1, auditRemediation: 0 });
  assert.equal(decision.status, 'resume-existing-delivery');
  assert.equal(decision.recoverWorkerRunId, undefined);
  assert.equal(decision.priorInitialAttempts, undefined);
  // #146 changes future budget transitions, not the already persisted escalation.
  assert.equal(decision.nextAction, 'human-escalation');
  assert.equal(parsed.persistent.auditEvidence.decision, 'rejected');
  assert.equal(parsed.persistent.blockingFindings.length, 4);
  assert.equal(evaluateOperationalRelease({ state: operationalStateFromPersistent(parsed.persistent) }).readiness, false);
});

test('existing trusted state resumes the same PR even after removal of the cosmetic managed title', () => {
  const legacy = { ...pullRequest, title: 'Adopt existing PRs' };
  assert.equal(selectExistingPullRequest([legacy], options), legacy);
  assert.deepEqual(reentry(legacy), reentry());
});

test('original SolverFin #613 / PR #660 is discovered without a V2 title; missing V2 state cannot start a duplicate implementation', () => {
  const legacy = snapshot.solverFin613.pullRequest;
  const selected = selectExistingPullRequest([legacy], { ...options, repository: 'crgasparoto-br/SolverFin', issueNumber: 613 });
  assert.equal(selected.number, 660);
  assert.equal(selected.head.ref, 'codex/613-budgets-multicurrency');
  assert.equal(selected.head.sha, '70499851ee7a96734a447bc3de50f7da56b8bf50');
  const decision = evaluateReentry({ pullRequest: selected, targetRepository: 'crgasparoto-br/SolverFin', issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  assert.equal(decision.runController, true);
  assert.equal(decision.pullRequestNumber, 660);
  assert.equal(decision.status, 'legacy-adopted');
  assert.equal(decision.resumePr, 660);
  assert.equal(decision.nextAction, 'post-write-refreeze');
  assert.deepEqual(decision.attempts, { implementation: null, audit: null, auditRemediation: null });
  // Legacy handoff prose is not a classifier, V2 attempt ledger or audit approval.
  assert.equal(snapshot.solverFin613.continuation.recovery_scope, 'post-write-refreeze');
});

test('every invalid linked PR fails closed instead of disappearing into new-delivery', () => {
  for (const mutate of [
    (pr) => { delete pr.state; },
    (pr) => { pr.state = 'closed'; },
    (pr) => { pr.user.login = 'another-member'; pr.author_association = 'MEMBER'; },
    (pr) => { pr.user.login = 'another-collaborator'; pr.author_association = 'COLLABORATOR'; },
    (pr) => { pr.author_association = 'NONE'; },
    (pr) => { delete pr.author_association; },
    (pr) => { pr.head.repo.full_name = 'someone/fork'; },
    (pr) => { pr.base.repo.full_name = 'someone/other'; },
    (pr) => { pr.base.ref = 'develop'; },
    (pr) => { pr.head.sha = ''; },
    (pr) => { pr.base.sha = 'main'; },
    (pr) => { pr.head.ref = ''; },
    (pr) => { pr.body = 'Closes #105\nCloses #106'; },
    (pr) => { pr.body = 'Closes #105\nCloses another/repo#105'; }
  ]) {
    const invalid = structuredClone(pullRequest);
    mutate(invalid);
    assert.throws(() => selectExistingPullRequest([invalid], options), undefined, mutate.toString());
    assert.throws(() => reentry(invalid), undefined, mutate.toString());
  }
  assert.throws(() => selectExistingPullRequest([pullRequest], { ...options, trustedLogin: undefined }), /trustedLogin/);
  assert.throws(() => selectExistingPullRequest([pullRequest], { ...options, repository: undefined }), /repository/);
});

test('managed and legacy candidates cannot mask ambiguity, including a divergent base', () => {
  const legacy = { ...pullRequest, number: 123, title: 'Existing implementation' };
  assert.throws(() => selectExistingPullRequest([pullRequest, legacy], options), /multiple open PRs/);
  assert.throws(() => selectExistingPullRequest([pullRequest, { ...legacy, base: { ...legacy.base, ref: 'develop' } }], options), /multiple open PRs/);
});

test('only explicit local or fully qualified closing relationships select a PR', () => {
  for (const body of ['Closes #105', 'Fixes crgasparoto-br/delivery-orchestrator#105', 'Resolves https://github.com/crgasparoto-br/delivery-orchestrator/issues/105']) {
    assert.equal(selectExistingPullRequest([{ ...pullRequest, body }], options).number, 122);
  }
  for (const body of ['Related to #105', 'Closes #1050', 'Closes someone/else#105', '> Closes #105', '`Closes #105`', '```\nCloses #105\n```', '<!-- Closes #105 -->']) {
    assert.equal(selectExistingPullRequest([{ ...pullRequest, body }], options), null);
  }
});

test('head or base drift invalidates downstream evidence without losing PR identity or resetting budgets', () => {
  for (const side of ['head', 'base']) {
    const changed = structuredClone(pullRequest);
    changed[side].sha = 'f'.repeat(40);
    const decision = reentry(changed);
    assert.equal(decision.resumePr, 122);
    assert.equal(decision.staleStateDetected, true);
    assert.equal(decision.nextAction, 'classify');
    assert.deepEqual(decision.attempts, { implementation: 3, audit: 1, auditRemediation: 0 });
  }
  for (const patch of [{ issueNumber: 106 }, { pullRequestNumber: 123 }, { headRef: 'wrong-branch' }, { repository: 'other/repo' }]) {
    assert.throws(() => reentry(pullRequest, { ...stateEnvelope, persistent: { ...stateEnvelope.persistent, ...patch } }), /does not match/);
  }
});
