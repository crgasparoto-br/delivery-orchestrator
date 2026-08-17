import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/delivery-loop.yml', import.meta.url);
const bootstrapUrl = new URL('../scripts/bootstrap-runner-roles.sh', import.meta.url);

test('workflow installs worker Python dependencies inside an isolated virtualenv', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /python3 -m venv \.venv/);
  assert.match(workflow, /\.venv\/bin\/python -m pip install/);
  assert.match(workflow, /GITHUB_PATH/);
  assert.doesNotMatch(
    workflow,
    /run:\s*python3 -m pip install -r skills\/catalog\/entregar-issue\/requirements\.txt/
  );
});

test('cleanup tolerates bootstrap failures before role users exist', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /if id "\$role_user" >\/dev\/null 2>&1; then/);
});

test('runner bootstrap creates isolated role users and validates required runtime tools', async () => {
  const bootstrap = await readFile(bootstrapUrl, 'utf8');

  assert.match(bootstrap, /delivery-implementer/);
  assert.match(bootstrap, /delivery-auditor/);
  assert.match(bootstrap, /useradd --create-home --shell \/bin\/bash/);
  assert.match(bootstrap, /\/etc\/sudoers\.d\/delivery-orchestrator-roles/);
  assert.match(bootstrap, /python3 -m venv/);
  assert.match(bootstrap, /visudo -cf/);
  assert.match(bootstrap, /command -v codex/);
  assert.match(bootstrap, /npm install -g @openai\/codex/);
  assert.match(bootstrap, /"\$codex_bin" --version/);
  assert.match(
    bootstrap,
    /sudo -n -u "\$runner_user" -H -- sudo -n -u "\$role_user" -H -- true/
  );
});
