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
  assert.equal(context.strategy, 'supplemental-changed-files-plus-direct-relative-dependencies-with-chunks');
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

test('large changed text file is represented by complete ordered exact-SHA chunks', async (t) => {
  const head = 'f'.repeat(40);
  const content = [
    'export function one() { return 1; }\n',
    'export function two() { return 2; }\n',
    'export function three() { return 3; }\n',
    'export function four() { return 4; }\n'
  ].join('').repeat(16);

  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async () => file(content, '9');

  const context = await fetchBoundedAuditContext(
    'owner/repo',
    head,
    ['src/large-service.mjs'],
    'token',
    {
      limits: {
        maxFiles: 4,
        maxFileBytes: 256,
        maxTotalBytes: 16 * 1024,
        maxDependencyProbes: 2
      }
    }
  );

  assert.equal(context.schemaVersion, 3);
  assert.equal(context.files.length, 0);
  assert.deepEqual(context.chunkedPaths, ['src/large-service.mjs']);
  assert.ok(context.chunks.length > 1);
  assert.equal(context.omitted.length, 0);

  const chunks = context.chunks;

  assert.deepEqual(
    chunks.map((item) => item.chunkIndex),
    Array.from({ length: chunks.length }, (_, index) => index)
  );

  assert.ok(
    chunks.every(
      (item) =>
        item.path === 'src/large-service.mjs' &&
        item.blobSha === '9'.repeat(40) &&
        item.chunkCount === chunks.length &&
        item.fileBytes === Buffer.byteLength(content, 'utf8') &&
        item.bytes <= 256
    )
  );

  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(
      chunks[index].startByte,
      chunks[index - 1].endByte
    );
  }

  assert.equal(chunks[0].startByte, 0);
  assert.equal(
    chunks.at(-1).endByte,
    Buffer.byteLength(content, 'utf8')
  );

  assert.equal(
    chunks.map((item) => item.content).join(''),
    content
  );

  assert.equal(
    new Set(chunks.map((item) => item.fileSha256)).size,
    1
  );
});

test('large file still fails bounded when complete chunk coverage exceeds total budget', async (t) => {
  const head = '8'.repeat(40);
  const content = 'x'.repeat(4096);

  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async () => file(content, '7');

  const context = await fetchBoundedAuditContext(
    'owner/repo',
    head,
    ['src/too-large.mjs'],
    'token',
    {
      limits: {
        maxFiles: 4,
        maxFileBytes: 512,
        maxTotalBytes: 1024,
        maxDependencyProbes: 2
      }
    }
  );

  assert.equal(context.files.length, 0);
  assert.equal(context.chunks.length, 0);
  assert.deepEqual(context.chunkedPaths, []);
  assert.equal(context.omitted.length, 1);
  assert.equal(context.omitted[0].path, 'src/too-large.mjs');
  assert.equal(context.omitted[0].reason, 'max-file-bytes');
});

test('chunked changed file remains a dependency seed without duplicate material reads', async (t) => {
  const head = '6'.repeat(40);
  const requested = [];

  const large = (
    "import { helper } from './helper.mjs';\n" +
    "export const run = () => helper();\n"
  ).repeat(20);

  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);

    if (value.includes('/contents/src/large-controller.mjs?')) {
      return file(large, '5');
    }

    if (value.includes('/contents/src/helper.mjs?')) {
      return file('export const helper = () => 1;\n', '4');
    }

    if (value.includes('/contents/src/helper?')) {
      return response({
        ok: false,
        status: 404,
        text: 'missing'
      });
    }

    throw new Error(`unexpected URL ${value}`);
  };

  const context = await fetchBoundedAuditContext(
    'owner/repo',
    head,
    ['src/large-controller.mjs'],
    'token',
    {
      limits: {
        maxFiles: 4,
        maxFileBytes: 256,
        maxTotalBytes: 16 * 1024,
        maxDependencyProbes: 4
      }
    }
  );

  assert.deepEqual(
    context.chunkedPaths,
    ['src/large-controller.mjs']
  );

  assert.ok(
    context.files.some(
      (item) =>
        item.path === 'src/helper.mjs' &&
        item.kind === 'direct-relative-dependency'
    )
  );

  assert.equal(
    requested.filter(
      (url) => url.includes('/contents/src/large-controller.mjs?')
    ).length,
    1
  );
});
