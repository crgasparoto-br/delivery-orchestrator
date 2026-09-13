import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { terminalReleaseStatusForControllerResult } from '../scripts/finalize-delivery-v2-controller-status.mjs';

test('escalated controller result becomes terminal failure on exact material head', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(terminalReleaseStatusForControllerResult({ status: 'escalated', materialHeadSha: sha, metrics: { terminalReason: 'implementation-budget-exhausted' } }), {
    sha,
    state: 'failure',
    description: 'Delivery V2 escalated: implementation-budget-exhausted'
  });
});

test('ready and nonterminal controller results are not overwritten by finalizer', () => {
  assert.equal(terminalReleaseStatusForControllerResult({ status: 'ready-for-human-merge', materialHeadSha: 'a'.repeat(40) }), null);
  assert.equal(terminalReleaseStatusForControllerResult({ status: 'ci-pending', materialHeadSha: 'a'.repeat(40) }), null);
});

test('dispatch always executes terminal finalizer after controller ownership', async () => {
  const body = await readFile('.github/workflows/delivery-v2-dispatch.yml', 'utf8');
  assert.match(body, /name: Finalize terminal release status/);
  assert.match(body, /if: always\(\) && steps\.reentry\.outputs\.run_controller == 'true'/);
  assert.match(body, /node scripts\/finalize-delivery-v2-controller-status\.mjs/);
});

test('CI emits generated worker bytes only when strict compile detects drift', async () => {
  const body = await readFile('.github/workflows/delivery-v2-ci.yml', 'utf8');
  assert.match(body, /gh aw compile --strict/);
  assert.match(body, /name: Upload compiled worker drift for deterministic remediation/);
  assert.match(body, /if: steps\.compiled-workers\.outputs\.drift == 'true'/);
  assert.match(body, /retention-days: 1/);
  assert.match(body, /git diff --exit-code -- \.github\/workflows\/delivery-v2-worker-\*\.lock\.yml \.github\/aw\/actions-lock\.json/);
  assert.doesNotMatch(body, /contents: write/);
});
