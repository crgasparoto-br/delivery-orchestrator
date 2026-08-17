import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/delivery-loop.yml', import.meta.url);
const bootstrapUrl = new URL('../scripts/bootstrap-runner-roles.sh', import.meta.url);

test('workflow stages Node, SDK, skills and Python dependencies in a shared runtime', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /DELIVERY_RUNTIME_ROOT: \/tmp\/delivery-orchestrator-runtime-/);
  assert.match(workflow, /cp -a src skills prompts schemas trust node_modules package\.json/);
  assert.match(workflow, /python3 -m venv "\$DELIVERY_RUNTIME_ROOT\/\.venv"/);
  assert.match(workflow, /"\$DELIVERY_RUNTIME_ROOT\/\.venv\/bin\/python" -m pip install/);
  assert.match(workflow, /chmod -R a\+rX "\$DELIVERY_RUNTIME_ROOT"/);
  assert.match(workflow, /chmod -R go-w "\$DELIVERY_RUNTIME_ROOT"/);
});

test('isolated roles and controller use the shared Node runtime instead of runner-private paths', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /node_bin="\/usr\/local\/bin\/node"/);
  assert.match(workflow, /worker="\$DELIVERY_RUNTIME_ROOT\/src\/role-runtime-worker\.mjs"/);
  assert.match(workflow, /sudo -n -u "\$role_user" -H -- "\$node_bin" "\$worker" probe-readable/);
  assert.match(workflow, /\/usr\/local\/bin\/node src\/cli\.mjs run/);
  assert.match(workflow, /RUNS_ROOT: \$\{\{ env\.DELIVERY_RUNTIME_ROOT \}\}\/runs/);
  assert.match(workflow, /SKILL_CATALOG: \$\{\{ env\.DELIVERY_RUNTIME_ROOT \}\}\/skills\/catalog/);
  assert.match(workflow, /PATH: \$\{\{ env\.DELIVERY_RUNTIME_ROOT \}\}\/\.venv\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/);
  assert.doesNotMatch(workflow, /node_bin="\$\(command -v node\)"/);
});

test('cleanup preserves forensic upload until after role workspaces are removed', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /if id "\$role_user" >\/dev\/null 2>&1; then/);
  assert.match(workflow, /path: \$\{\{ env\.DELIVERY_RUNTIME_ROOT \}\}\/runs\//);
  assert.match(workflow, /Remove shared orchestration runtime/);
  assert.match(workflow, /\/tmp\/delivery-orchestrator-runtime-\*\) rm -rf/);
});

test('runner bootstrap validates shared Node and Codex executability for both role users', async () => {
  const bootstrap = await readFile(bootstrapUrl, 'utf8');

  assert.match(bootstrap, /delivery-implementer/);
  assert.match(bootstrap, /delivery-auditor/);
  assert.match(bootstrap, /useradd --create-home --shell \/bin\/bash/);
  assert.match(bootstrap, /\/etc\/sudoers\.d\/delivery-orchestrator-roles/);
  assert.match(bootstrap, /python3 -m venv/);
  assert.match(bootstrap, /visudo -cf/);
  assert.match(bootstrap, /shared_node_bin="\/usr\/local\/bin\/node"/);
  assert.match(bootstrap, /Node\.js at \$shared_node_bin must be version 22 or newer/);
  assert.match(bootstrap, /sudo -n -u "\$role_user" -H -- "\$shared_node_bin" --version/);
  assert.match(bootstrap, /command -v codex/);
  assert.match(bootstrap, /CODEX_INSTALL_DIR=\/usr\/local\/bin/);
  assert.match(bootstrap, /CODEX_HOME=\/opt\/openai-codex/);
  assert.match(bootstrap, /"\$codex_bin" --version/);
  assert.match(
    bootstrap,
    /sudo -n -u "\$runner_user" -H -- sudo -n -u "\$role_user" -H -- true/
  );
});
