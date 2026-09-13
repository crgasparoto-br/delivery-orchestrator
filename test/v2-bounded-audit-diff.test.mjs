import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { boundAuditDiff } from '../src/v2/bounded-audit-diff.mjs';
import { materialAuditContextPaths } from '../scripts/run-delivery-v2-github-audit.mjs';

function block(path, payload) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${payload}\n+${payload}x\n`;
}

test('bounded audit diff preserves full-diff identity while limiting model context', () => {
  const diff = [
    block('docs/readme.md', 'docs'),
    block('src/core.mjs', 'core'),
    block('test/core.test.mjs', 'test')
  ].join('');
  const changedPaths = ['docs/readme.md', 'src/core.mjs', 'test/core.test.mjs'];
  const bounded = boundAuditDiff(diff, changedPaths, {
    limits: { maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.fullDiffSha256, createHash('sha256').update(diff).digest('hex'));
  assert.equal(bounded.manifest.fullDiffBytes, Buffer.byteLength(diff));
  assert.equal(bounded.manifest.alignmentExact, true);
  assert.deepEqual(bounded.manifest.included.map((item) => item.path), ['src/core.mjs']);
  assert.equal(bounded.manifest.omitted.length, 2);
  assert.match(bounded.text, /src\/core\.mjs/);
  assert.doesNotMatch(bounded.text, /docs\/readme\.md/);
  assert.doesNotMatch(bounded.text, /test\/core\.test\.mjs/);
});

test('generated locks and repetitive worker prompts cannot evict source and tests', () => {
  const paths = [
    '.github/workflows/delivery-v2-worker-codex-critical.lock.yml',
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    'src/v2/controller-observability.mjs',
    'test/v2-controller-observability.test.mjs'
  ];
  const diff = paths.map((filePath) => block(filePath, filePath)).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192 }
  });

  assert.deepEqual(bounded.manifest.included.map((item) => item.path), [
    'src/v2/controller-observability.mjs',
    'test/v2-controller-observability.test.mjs'
  ]);
  assert.equal(bounded.manifest.omitted.find((item) => item.path.endsWith('.lock.yml'))?.reason, 'generated-low-value');
  assert.equal(bounded.manifest.omitted.find((item) => item.path.endsWith('-critical.md'))?.reason, 'max-files');
  assert.doesNotMatch(bounded.text, /delivery-v2-worker-codex-critical/);
});

test('material context drops generated and repetitive prompts when core changes exist', () => {
  const mixed = materialAuditContextPaths([
    '.github/workflows/delivery-v2-worker-codex-critical.lock.yml',
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    'scripts/resume-delivery-v2-controller.mjs',
    'src/v2/controller-observability.mjs',
    'test/v2-controller-observability.test.mjs'
  ]);
  assert.deepEqual(mixed, [
    'scripts/resume-delivery-v2-controller.mjs',
    'src/v2/controller-observability.mjs',
    'test/v2-controller-observability.test.mjs'
  ]);

  const promptsOnly = materialAuditContextPaths([
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    '.github/workflows/delivery-v2-worker-claude-critical.md'
  ]);
  assert.deepEqual(promptsOnly, [
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    '.github/workflows/delivery-v2-worker-claude-critical.md'
  ]);
});

test('oversized diff blocks are omitted explicitly instead of being silently truncated', () => {
  const diff = block('src/large.mjs', 'x'.repeat(200));
  const bounded = boundAuditDiff(diff, ['src/large.mjs'], {
    limits: { maxFiles: 2, maxFileBytes: 64, maxTotalBytes: 128 }
  });

  assert.equal(bounded.text, '');
  assert.equal(bounded.manifest.included.length, 0);
  assert.equal(bounded.manifest.omitted[0].path, 'src/large.mjs');
  assert.equal(bounded.manifest.omitted[0].reason, 'max-file-bytes');
  assert.ok(bounded.manifest.omitted[0].bytes > 64);
});

test('GitHub-native auditor sends only bounded diff bytes plus an integrity manifest to the model bundle', async () => {
  const script = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8'));
  assert.match(script, /const diffEvidence = boundAuditDiff\(compareEvidence\.diffText, compareEvidence\.changedPaths\)/);
  assert.match(script, /const contextPaths = materialAuditContextPaths\(compareEvidence\.changedPaths\)/);
  assert.match(script, /evaluateAuditBundleBudget/);
  assert.match(script, /providerCalls: 0/);
  assert.match(script, /'CANDIDATE\.diff': diffEvidence\.text/);
  assert.match(script, /'DIFF_MANIFEST\.json'/);
  assert.doesNotMatch(script, /'CANDIDATE\.diff': compareEvidence\.diffText/);
});
