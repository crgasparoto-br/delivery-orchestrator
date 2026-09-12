import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('classifier sync workflow exports, verifies and opens a bounded target PR', async () => {
  const body = await readFile('.github/workflows/delivery-v2-sync-classifier.yml', 'utf8');
  assert.match(body, /workflow_dispatch:/);
  assert.match(body, /DELIVERY_V2_SYNC_TOKEN/);
  assert.match(body, /export-delivery-v2-classifier\.mjs/);
  assert.match(body, /verify\.mjs/);
  assert.match(body, /gh pr create/);
  assert.match(body, /git add \"\$PACKAGE_DIR\"/);
  assert.doesNotMatch(body, /gh pr merge|git merge|auto-merge/i);
});
