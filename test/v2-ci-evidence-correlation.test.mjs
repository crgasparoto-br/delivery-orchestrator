import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAuthoritativeSourceWorkflowRun, selectCheckForWorkflowRun, workflowRunIdFromCheck } from '../src/v2/ci-evidence-correlation.mjs';

const SHA = 'a'.repeat(40);

test('CI evidence selects the newest exact-head workflow run even when an older green run exists', () => {
  const older = { id: 10, run_number: 7, name: 'Delivery V2 CI', event: 'pull_request', head_sha: SHA, status: 'completed', conclusion: 'success' };
  const newer = { id: 11, run_number: 8, name: 'Delivery V2 CI', event: 'pull_request', head_sha: SHA, status: 'in_progress', conclusion: null };
  assert.equal(selectAuthoritativeSourceWorkflowRun([older, newer], { workflowName: 'Delivery V2 CI', sha: SHA }).id, 11);
});

test('required check is accepted only when details_url binds it to the authoritative workflow run', () => {
  const oldCheck = { id: 1, name: 'V2 platform checks', details_url: 'https://github.com/o/r/actions/runs/10/job/1' };
  const currentCheck = { id: 2, name: 'V2 platform checks', details_url: 'https://github.com/o/r/actions/runs/11/job/2' };
  assert.equal(workflowRunIdFromCheck(currentCheck), 11);
  assert.equal(selectCheckForWorkflowRun([oldCheck, currentCheck], { requiredStatusName: 'V2 platform checks', workflowRunId: 11 }).id, 2);
  assert.throws(() => selectCheckForWorkflowRun([currentCheck, { ...currentCheck, id: 3 }], { requiredStatusName: 'V2 platform checks', workflowRunId: 11 }), /ambiguous/);
});
