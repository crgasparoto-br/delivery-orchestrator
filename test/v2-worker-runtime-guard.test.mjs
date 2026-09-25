import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePath =
  '.github/workflows/delivery-v2-worker-codex-standard.md';

const lockPath =
  '.github/workflows/delivery-v2-worker-codex-standard.lock.yml';

test('STANDARD Codex worker keeps bounded context rebuild protection with explicit headroom', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(
    source,
    /GH_AW_CODEX_CONTEXT_REBUILD_CIRCUIT_BREAKER:\s*"true"/
  );

  assert.match(
    source,
    /GH_AW_CODEX_MAX_REBUILD_FACTOR:\s*"35"/
  );

  assert.match(
    source,
    /GH_AW_CODEX_REBUILD_MIN_CUMULATIVE_INPUT_TOKENS:\s*"1000000"/
  );

  const lock = await readFile(lockPath, 'utf8');

  assert.match(
    lock,
    /GH_AW_CODEX_CONTEXT_REBUILD_CIRCUIT_BREAKER:/
  );

  assert.match(
    lock,
    /GH_AW_CODEX_MAX_REBUILD_FACTOR:/
  );
});

test('CRITICAL Codex worker keeps bounded context rebuild protection with explicit headroom', async () => {
  const source = await readFile(
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    'utf8'
  );

  assert.match(
    source,
    /GH_AW_CODEX_CONTEXT_REBUILD_CIRCUIT_BREAKER:\s*"true"/
  );
  assert.match(source, /GH_AW_CODEX_MAX_REBUILD_FACTOR:\s*"35"/);
  assert.match(
    source,
    /GH_AW_CODEX_REBUILD_MIN_CUMULATIVE_INPUT_TOKENS:\s*"1000000"/
  );

  // The generated critical lock is verified later in Delivery V2 CI by
  // gh aw compile --strict followed by git diff --exit-code. Keeping this
  // test source-only lets that canonical generator run when frontmatter changes.
});

test('compiled STANDARD Codex worker provisions AWF for threat detection', async () => {
  const lock = await readFile(lockPath, 'utf8');

  const match = lock.match(
    /\n  detection:\n([\s\S]*?)(?=\n  [A-Za-z0-9_-]+:\n|\s*$)/
  );

  assert.ok(match, 'compiled worker must contain detection job');

  const detection = match[0];

  assert.match(
    detection,
    /- name: Install AWF binary/
  );

  assert.match(
    detection,
    /install_awf_binary\.sh/
  );
});
