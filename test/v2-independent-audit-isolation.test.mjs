import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { roleRuntimeWorkerPath } from '../src/role-runtime.mjs';

test('role runtime can execute from an explicitly isolated worker path', () => {
  assert.equal(
    roleRuntimeWorkerPath({ DELIVERY_ROLE_RUNTIME_WORKER: '/tmp/delivery-v2-role-runtime/role-runtime-worker.mjs' }),
    '/tmp/delivery-v2-role-runtime/role-runtime-worker.mjs'
  );
  assert.match(roleRuntimeWorkerPath({}), /src\/role-runtime-worker\.mjs$/);
});

test('generic independent auditor copies only the role runtime to auditor-owned temp storage', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-v2-audit.yml', import.meta.url), 'utf8');
  assert.match(workflow, /DELIVERY_ROLE_RUNTIME_ROOT: \/tmp\/delivery-v2-auditor-/);
  assert.match(workflow, /DELIVERY_ROLE_RUNTIME_WORKER: \/tmp\/delivery-v2-auditor-/);
  assert.match(workflow, /Prepare isolated auditor role runtime/);
  assert.match(workflow, /cp src\/role-runtime-worker\.mjs src\/files\.mjs/);
  assert.match(workflow, /cp -a node_modules/);
  assert.match(workflow, /chown -R .*DELIVERY_AUDITOR_USER/);
  assert.match(workflow, /Cleanup isolated auditor runtime/);
});

test('generic semantic auditor receives no GitHub token and no network access', async () => {
  const runner = await readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/role-runtime-worker.mjs', import.meta.url), 'utf8');

  assert.match(runner, /githubToken: ''/);
  assert.match(runner, /networkAccessEnabled: false/);
  assert.match(worker, /networkAccessEnabled: payload\.networkAccessEnabled !== false/);
});
