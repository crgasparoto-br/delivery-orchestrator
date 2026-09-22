import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('worker producer contract matches deterministic hygiene consumer expectations', async () => {
  const body = await readFile(
    '.github/workflows/shared/delivery-v2-worker-scope-guard.md',
    'utf8'
  );

  assert.match(
    body,
    /existingOwnerEvidence.*MUST always be arrays/s
  );

  assert.match(
    body,
    /structuralFindings.*mandatory `kind`/s
  );

  assert.match(
    body,
    /Never substitute free-form `claim`/
  );

  assert.match(
    body,
    /command -v pnpm && pnpm --version/
  );

  assert.match(
    body,
    /command -v safeoutputs && safeoutputs noop --help/
  );
});

test('Codex wrapper proves the same infrastructure before the worker executes', async () => {
  const body = await readFile(
    '.github/scripts/run-delivery-v2-codex-with-sandbox-preflight.sh',
    'utf8'
  );

  assert.match(body, /require_tool pnpm/);
  assert.match(body, /require_tool safeoutputs/);
  assert.match(body, /require_safeoutput noop/);
  assert.match(body, /allow_login_shell=false/);
  assert.match(body, /shell_environment_policy\.set\.PATH/);
  assert.match(body, /CODEX_BASH_ENV="\$BASH_ENV"/);
  assert.match(body, /shell_environment_policy\.set\.BASH_ENV/);
});


test('worker contract pins structural vocabulary and typed fields', async () => {
  const body = await readFile(
    '.github/workflows/shared/delivery-v2-worker-scope-guard.md',
    'utf8'
  );

  for (const kind of [
    'file-growth',
    'fallback',
    'workaround',
    'duplication',
    'parallel-abstraction',
    'dead-code',
    'responsibility-growth',
    'avoidable-complexity',
    'created-files',
    'textual-similarity'
  ]) {
    assert.match(body, new RegExp(`\\\`${kind}\\\``));
  }

  assert.match(body, /MUST be JSON booleans/);
  assert.match(body, /MUST be an integer >= 1/);
  assert.match(body, /must never crash the controller/);
  assert.match(body, /must never be silently interpreted as `PASS`/);
});
