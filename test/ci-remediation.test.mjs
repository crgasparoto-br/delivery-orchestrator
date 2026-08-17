import test from 'node:test';
import assert from 'node:assert/strict';
import { blockingExactHeadWorkflowRuns } from '../src/github-ci.mjs';
import { ciFingerprint } from '../src/fingerprint.mjs';
import { STATES } from '../src/constants.mjs';
import { initialState, transition } from '../src/state-machine.mjs';

test('blocking exact-head CI conclusions require remediation before audit', () => {
  const runs = [
    { id: 1, name: 'ok', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'abc' },
    { id: 2, name: 'neutral', event: 'pull_request', status: 'completed', conclusion: 'neutral', head_sha: 'abc' },
    { id: 3, name: 'skipped', event: 'pull_request', status: 'completed', conclusion: 'skipped', head_sha: 'abc' },
    { id: 4, name: 'tests', event: 'pull_request', status: 'completed', conclusion: 'failure', head_sha: 'abc', html_url: 'https://example.test/4' },
    { id: 5, name: 'cancelled', event: 'pull_request', status: 'completed', conclusion: 'cancelled', head_sha: 'abc' }
  ];
  assert.deepEqual(blockingExactHeadWorkflowRuns(runs).map((run) => run.name), ['tests', 'cancelled']);
});

test('CI fingerprint is stable across workflow run ids and urls', () => {
  const first = [{ id: 10, name: 'tests', event: 'pull_request', status: 'completed', conclusion: 'failure', html_url: 'https://example/10' }];
  const retry = [{ id: 99, name: 'tests', event: 'pull_request', status: 'completed', conclusion: 'failure', html_url: 'https://example/99' }];
  assert.equal(ciFingerprint(first), ciFingerprint(retry));
});

test('CI failure is a non-terminal state that can remediate or stop for no progress', () => {
  let state = initialState({ runId: 'r', repository: 'o/r', issueNumber: 1, maxCycles: 3 });
  state = transition(state, STATES.IMPLEMENTING);
  state = transition(state, STATES.HANDOFF_READY);
  state = transition(state, STATES.CI_FAILED, { fingerprint: 'abc' });
  assert.equal(state.status, STATES.CI_FAILED);
  assert.equal(transition(state, STATES.REMEDIATING).status, STATES.REMEDIATING);
  assert.equal(transition(state, STATES.NO_PROGRESS).status, STATES.NO_PROGRESS);
});
