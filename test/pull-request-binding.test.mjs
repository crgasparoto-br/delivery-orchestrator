import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReusablePullRequest } from '../src/pull-request-binding.mjs';

test('prefers a PR that closes the issue over a later related PR', () => {
  const result = selectReusablePullRequest([
    { number: 663, state: 'open', title: 'canonical', body: 'Closes #662', head: { ref: 'fix/662-canonical' } },
    { number: 664, state: 'open', title: 'duplicate', body: 'Related to #662', head: { ref: 'issue-662-other' } }
  ], 662);
  assert.equal(result.status, 'bound');
  assert.equal(result.pullRequest.number, 663);
});

test('binds a single branch-linked PR', () => {
  const result = selectReusablePullRequest([
    { number: 1058, state: 'open', title: 'preserve quantity', body: '', head: { ref: 'fix/1057-preserve-countable-variant-details' } }
  ], 1057);
  assert.equal(result.status, 'bound');
  assert.equal(result.pullRequest.number, 1058);
});

test('blocks equally plausible duplicate PRs', () => {
  const result = selectReusablePullRequest([
    { number: 1, state: 'open', body: 'Closes #42', head: { ref: 'a' } },
    { number: 2, state: 'open', body: 'Fixes #42', head: { ref: 'b' } }
  ], 42);
  assert.equal(result.status, 'ambiguous');
});
