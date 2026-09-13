import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Delivery V2 CI triggers on every repository script and syntax-checks executable V2 script surfaces generically', async () => {
  const ci = await readFile(new URL('../.github/workflows/delivery-v2-ci.yml', import.meta.url), 'utf8');

  assert.match(ci, /- 'scripts\/\*\*'/);
  assert.match(ci, /for file in scripts\/\*\.mjs; do/);
  assert.match(ci, /for file in \.github\/scripts\/\*\.mjs; do/);
  assert.doesNotMatch(ci, /node --check scripts\/run-delivery-v2-controller\.mjs/);
  assert.doesNotMatch(ci, /node --check scripts\/guard-delivery-v2-reentry\.mjs/);
});
