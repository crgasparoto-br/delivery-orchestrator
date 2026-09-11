import test from 'node:test';
import assert from 'node:assert/strict';
import { otherLiveWorkflowRuns, selectOldestQueuedControlIssue } from '../src/control-queue.mjs';

test('selects the oldest open delivery request issue', () => {
  const issues = [
    { number: 16, state: 'open', title: 'delivery-request: repo#2', created_at: '2026-09-11T02:24:27Z' },
    { number: 15, state: 'open', title: 'delivery-request: repo#1', created_at: '2026-09-11T02:24:22Z' },
    { number: 14, state: 'closed', title: 'delivery-request: repo#0', created_at: '2026-09-11T02:03:20Z' }
  ];
  assert.equal(selectOldestQueuedControlIssue(issues).number, 15);
});

test('does not treat pull requests or unrelated issues as queue items', () => {
  const issues = [
    { number: 1, state: 'open', title: 'delivery-request: repo#1', pull_request: {} },
    { number: 2, state: 'open', title: 'normal issue' }
  ];
  assert.equal(selectOldestQueuedControlIssue(issues), null);
});

test('ignores the current run but preserves any other live run', () => {
  const runs = [
    { id: 10, status: 'in_progress' },
    { id: 11, status: 'pending' },
    { id: 12, status: 'completed' }
  ];
  assert.deepEqual(otherLiveWorkflowRuns(runs, 10).map((run) => run.id), [11]);
});
