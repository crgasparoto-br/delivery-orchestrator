import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition } from '../src/state-machine.mjs';
import { STATES } from '../src/constants.mjs';

test('happy state path reaches COMPLETE', () => {
  let s = initialState({ runId: 'r', repository: 'o/r', issueNumber: 1, maxCycles: 3 });
  s = transition(s, STATES.IMPLEMENTING);
  s = transition(s, STATES.HANDOFF_READY);
  s = transition(s, STATES.AUDITING);
  s = transition(s, STATES.COMPLETE);
  assert.equal(s.status, STATES.COMPLETE);
  assert.equal(s.release_signal, null);
});

test('COMPLETE can fail closed when the independent release signal is invalid', () => {
  let s = initialState({ runId: 'r', repository: 'o/r', issueNumber: 1, maxCycles: 3 });
  s = transition(s, STATES.IMPLEMENTING);
  s = transition(s, STATES.HANDOFF_READY);
  s = transition(s, STATES.AUDITING);
  s = transition(s, STATES.COMPLETE);
  s = transition({ ...s, release_signal: { published: false, reason: 'head-mismatch' } }, STATES.FAILED, {
    reason: 'independent audit release signal failed: head-mismatch'
  });
  assert.equal(s.status, STATES.FAILED);
  assert.equal(s.release_signal.reason, 'head-mismatch');
});

test('cannot self-promote NEW directly to COMPLETE', () => {
  const s = initialState({ runId: 'r', repository: 'o/r', issueNumber: 1, maxCycles: 3 });
  assert.throws(() => transition(s, STATES.COMPLETE), /Invalid orchestrator transition/);
});

test('handoff can block externally while exact-head CI is pending', () => {
  let s = initialState({ runId: 'r', repository: 'o/r', issueNumber: 1, maxCycles: 3 });
  s = transition(s, STATES.IMPLEMENTING);
  s = transition(s, STATES.HANDOFF_READY);
  s = transition(s, STATES.BLOCKED_EXTERNAL);
  assert.equal(s.status, STATES.BLOCKED_EXTERNAL);
});
