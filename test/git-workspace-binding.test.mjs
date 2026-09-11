import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneForImplementation } from '../src/git-workspace.mjs';

test('implementation clone binds to the existing PR branch', async () => {
  let observed;
  const runRoleTaskFn = async (user, task, payload) => {
    observed = { user, task, payload };
    return { dest: payload.dest };
  };
  await cloneForImplementation({
    repository: 'owner/repo',
    dest: '/tmp/repo',
    token: 'token',
    roleUser: 'implementer',
    branch: 'fix/42-existing',
    runRoleTaskFn
  });
  assert.equal(observed.task, 'clone');
  assert.equal(observed.payload.branch, 'fix/42-existing');
});
