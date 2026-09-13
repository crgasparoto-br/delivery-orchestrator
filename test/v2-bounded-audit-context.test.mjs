import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchBoundedAuditContext } from '../src/v2/github-audit-evidence.mjs';

function response({ ok = true, status = 200, json = null, text = '' } = {}) {
  return {
    ok,
    status,
    async json() { return json; },
    async text() { return text; }
  };
}

function file(content, shaChar) {
  return response({ json: { type: 'file', encoding: 'base64', sha: shaChar.repeat(40), content: Buffer.from(content).toString('base64') } });
}

test('audit context expands exact-SHA changed source into bounded full file plus direct dependency', async (t) => {
  const head = 'a'.repeat(40);
  const requested = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);
    assert.match(value, new RegExp(`\\?ref=${head}$`));
    if (value.includes('/contents/src/controller.mjs?')) return file("import { helper } from './helper.mjs';\nexport const run = () => helper();\n", 'b');
    if (value.includes('/contents/src/helper?')) return response({ ok: false, status: 404, text: 'missing' });
    if (value.includes('/contents/src/helper.mjs?')) return file('export const helper = () => 1;\n', 'c');
    throw new Error(`unexpected URL ${value}`);
  };

  const context = await fetchBoundedAuditContext(
    'owner/repo',
    head,
    ['src/controller.mjs', '.audit/entregar-issue/handoff-ready.json', '.github/workflows/generated.lock.yml'],
    'token',
    { limits: { maxFiles: 4, maxFileBytes: 4096, maxTotalBytes: 8192, maxDependencyProbes: 4 } }
  );

  assert.equal(context.candidateSha, head);
  assert.equal(context.strategy, 'supplemental-changed-files-plus-direct-relative-dependencies');
  assert.deepEqual(context.files.map((item) => [item.path, item.kind]), [
    ['src/controller.mjs', 'changed'],
    ['src/helper.mjs', 'direct-relative-dependency']
  ]);
  assert.equal(requested.some((url) => url.includes('/.audit/')), false);
  assert.equal(requested.some((url) => url.includes('.lock.yml')), false);
  assert.ok(context.totalBytes > 0);
});

test('audit context fails bounded rather than silently over-reading a large changed file', async (t) => {
  const head = 'd'.repeat(40);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => file('x'.repeat(64), 'e');

  const context = await fetchBoundedAuditContext('owner/repo', head, ['src/large.mjs'], 'token', {
    limits: { maxFiles: 2, maxFileBytes: 16, maxTotalBytes: 32, maxDependencyProbes: 2 }
  });
  assert.equal(context.files.length, 0);
  assert.equal(context.omitted[0].reason, 'max-file-bytes');
});
