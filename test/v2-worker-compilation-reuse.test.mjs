import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { requiresWorkerCompilation } from '../scripts/should-compile-delivery-v2-workers.mjs';

test('worker compilation reuses trusted base attestation for unrelated Delivery V2 changes', () => {
  assert.equal(requiresWorkerCompilation(['src/v2/operational-controller.mjs', 'test/v2-operational-controller.test.mjs']), false);
  assert.equal(requiresWorkerCompilation(['.github/workflows/delivery-v2-worker-codex-fast.md']), true);
  assert.equal(requiresWorkerCompilation(['.github/workflows/delivery-v2-worker-codex-fast.lock.yml']), true);
  assert.equal(requiresWorkerCompilation(['.github/workflows/shared/delivery-v2-worker-scope-guard.md']), true);
  assert.equal(requiresWorkerCompilation(['.github/aw/actions-lock.json']), true);
  assert.equal(requiresWorkerCompilation(['.github/workflows/delivery-v2-ci.yml']), true);
});

test('platform CI gates gh-aw setup and compile on worker identity drift', async () => {
  const ci = await readFile(new URL('../.github/workflows/delivery-v2-ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /Detect gh-aw worker identity drift/);
  assert.match(ci, /node scripts\/should-compile-delivery-v2-workers\.mjs/);
  assert.match(ci, /if: steps\.worker-identity\.outputs\.changed == 'true'/);
  assert.match(ci, /Reuse trusted-base gh-aw attestation/);
  assert.match(ci, /\.github\/workflows\/shared\/\*\*/);
});
