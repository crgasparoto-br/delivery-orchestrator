import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  assertPullRequestSnapshotStable,
  fetchAuditClassifier,
  fetchBoundedAuditContext,
  fetchImmutableCompareEvidence
} from '../src/v2/github-audit-evidence.mjs';

function response({ ok = true, status = 200, json = null, text = '' } = {}) {
  return {
    ok, status,
    async json() { return json; },
    async text() { return text; }
  };
}

function encodedFileResponse(filePath, content) {
  return response({
    json: {
      type: 'file',
      encoding: 'base64',
      sha: createHash('sha1').update(filePath).digest('hex'),
      content: Buffer.from(content).toString('base64')
    }
  });
}

test('self target classifier uses exact risk-profile fallback while external target fails closed', async (t) => {
  const source = 'export const x = 1;\n';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/contents/.delivery-v2/lock.json')) return response({ ok: false, status: 404, text: 'missing' });
    if (String(url).includes('/contents/src/v2/risk-profile.mjs')) return response({ json: { type: 'file', encoding: 'base64', sha: 'b'.repeat(40), content: Buffer.from(source).toString('base64') } });
    throw new Error(`unexpected URL ${url}`);
  };
  const classifier = await fetchAuditClassifier('crgasparoto-br/delivery-orchestrator', 'a'.repeat(40), 'token', { orchestratorRepository: 'crgasparoto-br/delivery-orchestrator' });
  assert.equal(classifier.version, 'delivery-v2-risk-profile-v1');
  assert.equal(classifier.fingerprint, createHash('sha256').update(source).digest('hex'));
  await assert.rejects(() => fetchAuditClassifier('crgasparoto-br/other', 'a'.repeat(40), 'token', { orchestratorRepository: 'crgasparoto-br/delivery-orchestrator' }), /GitHub API 404/);
});

test('material context uses the shared semantic policy across monorepo code, co-located tests and control surfaces', async (t) => {
  const head = '2'.repeat(40);
  const contents = new Map([
    ['apps/web/src/core.tsx', 'export const core = true;\n'],
    ['apps/web/src/core.test.tsx', 'export const test = true;\n'],
    ['.delivery-v2/lock.json', '{"version":2}\n'],
    ['docs/delivery-v2/evidence/dv2-sample.json', '{"status":"ok"}\n'],
    ['docs/delivery-v2/MASTER_SPEC.md', '# Canonical contract\n'],
    ['.github/workflows/delivery-v2-worker-codex-critical.md', '# prompt\n']
  ]);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const match = String(url).match(/\/contents\/(.+)\?ref=/);
    if (!match) throw new Error(`unexpected URL ${url}`);
    const filePath = decodeURIComponent(match[1]);
    const content = contents.get(filePath);
    if (content == null) return response({ ok: false, status: 404, text: 'missing' });
    return encodedFileResponse(filePath, content);
  };

  const context = await fetchBoundedAuditContext('crgasparoto-br/example', head, [
    '.github/workflows/delivery-v2-worker-codex-critical.lock.yml',
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    'docs/delivery-v2/MASTER_SPEC.md',
    'docs/delivery-v2/evidence/dv2-sample.json',
    '.delivery-v2/lock.json',
    'apps/web/src/core.test.tsx',
    'apps/web/src/core.tsx'
  ], 'token', { limits: { maxFiles: 6, maxFileBytes: 4096, maxTotalBytes: 16384, maxDependencyProbes: 1 } });

  assert.deepEqual(context.files.map((item) => [item.path, item.category]), [
    ['apps/web/src/core.tsx', 'executable'],
    ['apps/web/src/core.test.tsx', 'tests'],
    ['.delivery-v2/lock.json', 'config'],
    ['docs/delivery-v2/evidence/dv2-sample.json', 'evidence'],
    ['docs/delivery-v2/MASTER_SPEC.md', 'canonical-docs'],
    ['.github/workflows/delivery-v2-worker-codex-critical.md', 'prompts']
  ]);
  assert.equal(context.omitted.find((item) => item.path.endsWith('.lock.yml'))?.reason, 'non-material-or-generated');
});

test('material context supplements diff-represented paths instead of duplicating their bytes', async (t) => {
  const head = '3'.repeat(40);
  const contents = new Map([
    ['src/v2/core.mjs', 'import "./dep.mjs";\nexport const core = true;\n'],
    ['src/v2/dep.mjs', 'export const dep = true;\n'],
    ['test/v2-core.test.mjs', 'export const test = true;\n'],
    ['config/delivery-v2-requirements.json', '{"requirements":[{"id":"DV2-013","minimumCompletionStatus":"rolled-out"}]}\n'],
    ['docs/delivery-v2/ADR-0006.md', '# Bounded polling\n'],
    ['.github/workflows/delivery-v2-worker-codex-critical.md', '# prompt without retired roots\n']
  ]);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const match = String(url).match(/\/contents\/(.+)\?ref=/);
    if (!match) throw new Error(`unexpected URL ${url}`);
    const filePath = decodeURIComponent(match[1]);
    const content = contents.get(filePath);
    if (content == null) return response({ ok: false, status: 404, text: 'missing' });
    return encodedFileResponse(filePath, content);
  };

  const changedPaths = [
    'src/v2/core.mjs',
    'test/v2-core.test.mjs',
    'config/delivery-v2-requirements.json',
    'docs/delivery-v2/ADR-0006.md',
    '.github/workflows/delivery-v2-worker-codex-critical.md'
  ];
  const context = await fetchBoundedAuditContext('crgasparoto-br/example', head, changedPaths, 'token', {
    representedPaths: ['src/v2/core.mjs', 'test/v2-core.test.mjs'],
    limits: { maxFiles: 8, maxFileBytes: 4096, maxTotalBytes: 8192, maxDependencyProbes: 8 }
  });

  assert.deepEqual(context.representedPaths, ['src/v2/core.mjs', 'test/v2-core.test.mjs']);
  assert.equal(context.files.some((item) => item.path === 'src/v2/core.mjs'), false);
  assert.equal(context.files.some((item) => item.path === 'test/v2-core.test.mjs'), false);
  assert.ok(context.files.some((item) => item.path === 'config/delivery-v2-requirements.json'));
  assert.ok(context.files.some((item) => item.path === 'docs/delivery-v2/ADR-0006.md'));
  assert.ok(context.files.some((item) => item.path.endsWith('-critical.md')));
  assert.ok(context.files.some((item) => item.path === 'src/v2/dep.mjs' && item.kind === 'direct-relative-dependency'));
  assert.equal(context.omitted.find((item) => item.path === 'src/v2/core.mjs')?.reason, 'represented-in-bounded-diff');
  assert.equal(context.omitted.find((item) => item.path === 'test/v2-core.test.mjs')?.reason, 'represented-in-bounded-diff');
});

test('material context admits common non-JavaScript source extensions without changing byte ceilings', async (t) => {
  const head = '5'.repeat(40);
  const contents = new Map([
    ['apps/api/main.go', 'package main\n'],
    ['prisma/schema.prisma', 'model User { id Int @id }\n']
  ]);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const match = String(url).match(/\/contents\/(.+)\?ref=/);
    const filePath = match ? decodeURIComponent(match[1]) : '';
    const content = contents.get(filePath);
    if (content == null) return response({ ok: false, status: 404, text: 'missing' });
    return encodedFileResponse(filePath, content);
  };

  const context = await fetchBoundedAuditContext('crgasparoto-br/example', head, [...contents.keys()], 'token', {
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192, maxDependencyProbes: 1 }
  });
  assert.equal(context.files.length, 2);
  assert.ok(context.files.every((item) => item.category === 'executable'));
});

test('represented audit paths must belong to the immutable changed-path set', async () => {
  await assert.rejects(() => fetchBoundedAuditContext('crgasparoto-br/example', '4'.repeat(40), ['src/a.mjs'], 'token', {
    representedPaths: ['src/not-changed.mjs'],
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192, maxDependencyProbes: 1 }
  }), /represented audit path is not changed/);
});

test('audit changed paths and diff come only from immutable base...candidate compare', async (t) => {
  const base = '1'.repeat(40);
  const head = '2'.repeat(40);
  const urls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options = {}) => {
    urls.push(String(url));
    assert.match(String(url), new RegExp(`/compare/${base}\\.\\.\\.${head}$`));
    if (options.headers?.Accept === 'application/vnd.github.v3.diff') return response({ text: 'diff --git a/a b/a\n' });
    return response({ json: { base_commit: { sha: base }, merge_base_commit: { sha: base }, commits: [{ sha: head }], files: [{ filename: 'src/a.mjs' }, { filename: 'test/a.test.mjs' }] } });
  };
  const evidence = await fetchImmutableCompareEvidence('crgasparoto-br/example', base, head, 'token');
  assert.deepEqual(evidence.changedPaths, ['src/a.mjs', 'test/a.test.mjs']);
  assert.equal(evidence.diffText, 'diff --git a/a b/a\n');
  assert.equal(urls.length, 2);
  assert.equal(urls.some((url) => /\/pulls\//.test(url)), false);
});

test('audit refuses mixed PR head/base snapshots', () => {
  const base = '1'.repeat(40);
  const head = '2'.repeat(40);
  assert.deepEqual(assertPullRequestSnapshotStable({ base: { sha: base }, head: { sha: head } }, { base: { sha: base }, head: { sha: head } }), { baseSha: base, candidateSha: head });
  assert.throws(() => assertPullRequestSnapshotStable({ base: { sha: base }, head: { sha: head } }, { base: { sha: base }, head: { sha: '3'.repeat(40) } }), /changed while collecting/);
});
