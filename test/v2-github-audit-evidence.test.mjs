import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  assertPullRequestSnapshotStable,
  fetchAuditClassifier,
  fetchImmutableCompareEvidence
} from '../src/v2/github-audit-evidence.mjs';

function response({ ok = true, status = 200, json = null, text = '' } = {}) {
  return {
    ok, status,
    async json() { return json; },
    async text() { return text; }
  };
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
