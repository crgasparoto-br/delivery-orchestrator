import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { boundAuditDiff } from '../src/v2/bounded-audit-diff.mjs';

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

test('semantic representatives survive realistic code-heavy blocks under the unchanged 64 KiB ceiling', () => {
  const paths = [
    ...Array.from({ length: 8 }, (_, index) => `src/v2/heavy-${index}.mjs`),
    'test/v2-heavy.test.mjs',
    'config/delivery-v2-requirements.json',
    'docs/delivery-v2/evidence/dv2-013-training-system-fast.json',
    'docs/delivery-v2/ADR-0006.md',
    '.github/workflows/delivery-v2-worker-codex-critical.md'
  ];
  const payloads = paths.map((filePath) => filePath.startsWith('src/v2/heavy-') ? 'x'.repeat(2800) : 'y'.repeat(3800));
  const diff = paths.map((filePath, index) => block(filePath, payloads[index])).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 20, maxFileBytes: 12 * 1024, maxTotalBytes: 64 * 1024 }
  });
  const included = new Set(bounded.manifest.included.map((item) => item.path));

  assert.ok([...included].some((filePath) => filePath.startsWith('src/v2/heavy-')));
  assert.ok(included.has('test/v2-heavy.test.mjs'));
  assert.ok(included.has('config/delivery-v2-requirements.json'));
  assert.ok(included.has('docs/delivery-v2/evidence/dv2-013-training-system-fast.json'));
  assert.ok(included.has('docs/delivery-v2/ADR-0006.md'));
  assert.ok(included.has('.github/workflows/delivery-v2-worker-codex-critical.md'));
  for (const category of ['executable', 'tests', 'config', 'evidence', 'docs', 'prompts']) {
    assert.equal(bounded.manifest.categoryReservations[category].included, true, `missing representative for ${category}`);
  }
  assert.ok(bounded.manifest.boundedBytes <= 64 * 1024);
  assert.equal(bounded.manifest.strategy, 'bounded-semantic-class-representative-unified-diff');
});

test('co-located test files under src receive the tests reservation', () => {
  const paths = ['src/v2/controller.mjs', 'src/v2/controller.test.mjs'];
  const diff = paths.map((filePath) => block(filePath, 'x'.repeat(400))).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.included.find((item) => item.path === 'src/v2/controller.test.mjs')?.category, 'tests');
  assert.equal(bounded.manifest.categoryReservations.tests.path, 'src/v2/controller.test.mjs');
  assert.equal(bounded.manifest.categoryReservations.tests.included, true);
});

test('diff blocks bind to their own headers even when GitHub changed-path order differs', () => {
  const diff = [block('src/a.mjs', 'a'), block('src/b.mjs', 'b')].join('');
  const bounded = boundAuditDiff(diff, ['src/b.mjs', 'src/a.mjs'], {
    limits: { maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.alignmentExact, true);
  assert.deepEqual(bounded.manifest.included.map((item) => item.path), ['src/a.mjs']);
  assert.deepEqual(bounded.manifest.omitted.map((item) => item.path), ['src/b.mjs']);
  assert.match(bounded.text, /diff --git a\/src\/a\.mjs b\/src\/a\.mjs/);
  assert.doesNotMatch(bounded.text, /diff --git a\/src\/b\.mjs b\/src\/b\.mjs/);
});

test('path-set mismatch cannot be mistaken for exact alignment', () => {
  const diff = [block('src/a.mjs', 'a'), block('src/b.mjs', 'b')].join('');
  const bounded = boundAuditDiff(diff, ['src/a.mjs', 'src/c.mjs'], {
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192 }
  });

  assert.equal(bounded.manifest.alignmentExact, false);
  assert.equal(bounded.manifest.strategy, 'bounded-unified-diff-unverified-path-alignment');
  assert.equal(bounded.manifest.included.find((item) => item.index === 1)?.path, null);
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

test('GitHub-native auditor suppresses supplemental context only for verified diff-path alignment', async () => {
  const script = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8'));
  assert.match(script, /const diffEvidence = boundAuditDiff\(compareEvidence\.diffText, compareEvidence\.changedPaths\)/);
  assert.match(script, /const representedPaths = diffEvidence\.manifest\.alignmentExact[\s\S]*?\? diffEvidence\.manifest\.included\.map\(\(entry\) => entry\.path\)\.filter\(Boolean\)[\s\S]*?: \[\];/);
  assert.match(script, /fetchBoundedAuditContext\(repository, candidateSha, compareEvidence\.changedPaths, token, \{ representedPaths \}\)/);
  assert.match(script, /reserves one eligible representative from each semantic class before any spillover/);
  assert.match(script, /evaluateAuditBundleBudget/);
  assert.match(script, /providerCalls: 0/);
  assert.match(script, /'CANDIDATE\.diff': diffEvidence\.text/);
  assert.match(script, /'DIFF_MANIFEST\.json'/);
  assert.doesNotMatch(script, /'CANDIDATE\.diff': compareEvidence\.diffText/);
});
