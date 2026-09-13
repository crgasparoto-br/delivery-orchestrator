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
    block('src/core.mjs', 'core')
  ].join('');
  const changedPaths = ['docs/readme.md', 'src/core.mjs'];
  const bounded = boundAuditDiff(diff, changedPaths, {
    limits: { maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.fullDiffSha256, createHash('sha256').update(diff).digest('hex'));
  assert.equal(bounded.manifest.fullDiffBytes, Buffer.byteLength(diff));
  assert.equal(bounded.manifest.alignmentExact, true);
  assert.equal(bounded.manifest.reservationCoverageComplete, true);
  assert.deepEqual(bounded.manifest.included.map((item) => item.path), ['src/core.mjs']);
  assert.equal(bounded.manifest.omitted.length, 1);
  assert.match(bounded.text, /src\/core\.mjs/);
  assert.doesNotMatch(bounded.text, /docs\/readme\.md/);
});

test('generated locks cannot evict required source, tests and active worker prompts', () => {
  const paths = [
    '.github/workflows/delivery-v2-worker-codex-critical.lock.yml',
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    'src/v2/controller-observability.mjs',
    'test/v2-controller-observability.test.mjs'
  ];
  const diff = paths.map((filePath) => block(filePath, filePath)).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 3, maxFileBytes: 4096, maxTotalBytes: 8192 }
  });
  const included = new Set(bounded.manifest.included.map((item) => item.path));

  assert.equal(bounded.manifest.reservationCoverageComplete, true);
  assert.ok(included.has('.github/workflows/delivery-v2-worker-codex-critical.md'));
  assert.ok(included.has('src/v2/controller-observability.mjs'));
  assert.ok(included.has('test/v2-controller-observability.test.mjs'));
  assert.equal(bounded.manifest.omitted.find((item) => item.path.endsWith('.lock.yml'))?.reason, 'generated-low-value');
});

test('semantic representatives survive realistic code-heavy blocks under the unchanged 64 KiB ceiling', () => {
  const paths = [
    ...Array.from({ length: 8 }, (_, index) => `src/v2/heavy-${index}.mjs`),
    'test/v2-heavy.test.mjs',
    'config/delivery-v2-requirements.json',
    'docs/delivery-v2/evidence/dv2-013-training-system-fast.json',
    'docs/delivery-v2/MASTER_SPEC.md',
    '.github/workflows/delivery-v2-worker-codex-critical.md'
  ];
  const payloads = paths.map((filePath) => filePath.startsWith('src/v2/heavy-') ? 'x'.repeat(2800) : 'y'.repeat(3800));
  const diff = paths.map((filePath, index) => block(filePath, payloads[index])).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 20, maxFileBytes: 12 * 1024, maxTotalBytes: 64 * 1024 }
  });
  const included = new Set(bounded.manifest.included.map((item) => item.path));

  assert.equal(bounded.manifest.reservationCoverageComplete, true);
  assert.ok([...included].some((filePath) => filePath.startsWith('src/v2/heavy-')));
  assert.ok(included.has('test/v2-heavy.test.mjs'));
  assert.ok(included.has('config/delivery-v2-requirements.json'));
  assert.ok(included.has('docs/delivery-v2/evidence/dv2-013-training-system-fast.json'));
  assert.ok(included.has('docs/delivery-v2/MASTER_SPEC.md'));
  assert.ok(included.has('.github/workflows/delivery-v2-worker-codex-critical.md'));
  for (const category of ['executable', 'tests', 'config', 'evidence', 'canonical-docs', 'prompts']) {
    assert.equal(bounded.manifest.categoryReservations[category].included, true, `missing representative for ${category}`);
  }
  assert.ok(bounded.manifest.boundedBytes <= 64 * 1024);
  assert.equal(bounded.manifest.strategy, 'bounded-semantic-class-representative-unified-diff');
});

test('semantic reservation overflow fails closed before spillover under the unchanged 64 KiB ceiling', () => {
  const paths = [
    'src/v2/heavy.mjs',
    'test/v2-heavy.test.mjs',
    'config/delivery-v2-requirements.json',
    'docs/delivery-v2/evidence/dv2-013-training-system-fast.json',
    'docs/delivery-v2/MASTER_SPEC.md',
    '.github/workflows/delivery-v2-worker-codex-critical.md'
  ];
  const diff = paths.map((filePath, index) => block(filePath, String(index).repeat(8000))).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 40, maxFileBytes: 24 * 1024, maxTotalBytes: 64 * 1024 }
  });

  assert.equal(bounded.manifest.requiredReservationCount, 6);
  assert.ok(bounded.manifest.requiredReservationBytes > 64 * 1024);
  assert.equal(bounded.manifest.reservationCoverageComplete, false);
  assert.ok(bounded.manifest.reservationFailureReasons.includes('required-reservation-byte-limit-exceeded'));
  assert.equal(bounded.manifest.included.length, 0);
  assert.equal(bounded.manifest.boundedBytes, 0);
  assert.ok(bounded.manifest.omitted.every((item) => item.reason === 'semantic-reservation-incomplete'));
});

test('required semantic category with no individually eligible block fails closed', () => {
  const path = 'src/v2/oversized.mjs';
  const bounded = boundAuditDiff(block(path, 'x'.repeat(3000)), [path], {
    limits: { maxFiles: 4, maxFileBytes: 1024, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.categoryReservations.executable.required, true);
  assert.equal(bounded.manifest.categoryReservations.executable.included, false);
  assert.equal(bounded.manifest.reservationCoverageComplete, false);
  assert.ok(bounded.manifest.reservationFailureReasons.includes('required-category-no-eligible-representative:executable'));
  assert.equal(bounded.manifest.omitted[0].reason, 'max-file-bytes');
});

test('canonical Delivery V2 docs cannot be displaced by a smaller noncanonical document', () => {
  const paths = [
    'src/v2/primary.mjs',
    'src/v2/spillover.mjs',
    'test/v2-primary.test.mjs',
    'config/delivery-v2-requirements.json',
    'docs/delivery-v2/evidence/dv2-013-training-system-fast.json',
    '.github/workflows/delivery-v2-worker-codex-critical.md',
    'docs/changelog.md',
    'docs/delivery-v2/MASTER_SPEC.md'
  ];
  const payloadByPath = new Map([
    ['src/v2/primary.mjs', 'e'.repeat(1200)],
    ['src/v2/spillover.mjs', 's'.repeat(1200)],
    ['test/v2-primary.test.mjs', 't'.repeat(150)],
    ['config/delivery-v2-requirements.json', 'c'.repeat(150)],
    ['docs/delivery-v2/evidence/dv2-013-training-system-fast.json', 'v'.repeat(150)],
    ['.github/workflows/delivery-v2-worker-codex-critical.md', 'p'.repeat(150)],
    ['docs/changelog.md', 'd'.repeat(30)],
    ['docs/delivery-v2/MASTER_SPEC.md', 'm'.repeat(1000)]
  ]);
  const diff = paths.map((filePath) => block(filePath, payloadByPath.get(filePath))).join('');
  const canonicalBlockBytes = Buffer.byteLength(block('docs/delivery-v2/MASTER_SPEC.md', payloadByPath.get('docs/delivery-v2/MASTER_SPEC.md')));
  assert.ok(canonicalBlockBytes <= 4096, 'canonical fixture must remain individually eligible');

  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 12, maxFileBytes: 4096, maxTotalBytes: 8 * 1024 }
  });
  const included = new Set(bounded.manifest.included.map((item) => item.path));

  assert.equal(bounded.manifest.categoryReservations['canonical-docs'].path, 'docs/delivery-v2/MASTER_SPEC.md');
  assert.equal(bounded.manifest.categoryReservations['canonical-docs'].included, true);
  assert.equal(bounded.manifest.categoryReservations.docs.required, false);
  assert.ok(included.has('docs/delivery-v2/MASTER_SPEC.md'));
  assert.equal(bounded.manifest.included.find((item) => item.path === 'docs/delivery-v2/MASTER_SPEC.md')?.category, 'canonical-docs');
  assert.ok(bounded.manifest.boundedBytes <= 8 * 1024);
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

test('rename-only, mode-only, binary and C-quoted paths retain exact identity without hunk headers', () => {
  const cases = [
    {
      path: 'src/new-name.mjs',
      diff: 'diff --git a/src/old-name.mjs b/src/new-name.mjs\nsimilarity index 100%\nrename from src/old-name.mjs\nrename to src/new-name.mjs\n'
    },
    {
      path: 'scripts/run.sh',
      diff: 'diff --git a/scripts/run.sh b/scripts/run.sh\nold mode 100644\nnew mode 100755\n'
    },
    {
      path: 'assets/logo.bin',
      diff: 'diff --git a/assets/logo.bin b/assets/logo.bin\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/assets/logo.bin differ\n'
    },
    {
      path: 'docs/café.md',
      diff: 'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"\nold mode 100644\nnew mode 100755\n'
    }
  ];

  for (const current of cases) {
    const bounded = boundAuditDiff(current.diff, [current.path], {
      limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192 }
    });
    assert.equal(bounded.manifest.alignmentExact, true, current.path);
    assert.equal(bounded.manifest.included[0]?.path, current.path);
  }
});

test('unverified diff-path identity fails closed instead of disabling semantic reservations', () => {
  const diff = [block('src/a.mjs', 'a'), block('src/b.mjs', 'b')].join('');
  assert.throws(
    () => boundAuditDiff(diff, ['src/a.mjs', 'src/c.mjs'], {
      limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192 }
    }),
    /audit diff path alignment could not be proven; refusing semantic audit context/
  );
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
  assert.equal(bounded.manifest.reservationCoverageComplete, false);
  assert.ok(bounded.manifest.reservationFailureReasons.includes('required-category-no-eligible-representative:executable'));
});

test('GitHub-native auditor blocks incomplete semantic reservations through the deterministic bundle budget', async () => {
  const script = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8'));
  assert.match(script, /const diffEvidence = boundAuditDiff\(compareEvidence\.diffText, compareEvidence\.changedPaths\)/);
  assert.match(script, /if \(!diffEvidence\.manifest\.alignmentExact\) throw new Error\('audit diff path alignment could not be proven; refusing semantic audit before model invocation'\);/);
  assert.match(script, /const semanticReservationPreflightReasons = diffEvidence\.manifest\.reservationCoverageComplete/);
  assert.match(script, /bounded-diff:\$\{reason\}/);
  assert.match(script, /preflightReasons: semanticReservationPreflightReasons/);
  assert.match(script, /const representedPaths = diffEvidence\.manifest\.included\.map\(\(entry\) => entry\.path\)\.filter\(Boolean\);/);
  assert.match(script, /fetchBoundedAuditContext\(repository, candidateSha, compareEvidence\.changedPaths, token, \{ representedPaths \}\)/);
  assert.match(script, /If all required semantic reservations cannot fit simultaneously, the runtime marks the bundle blocked and returns a zero-provider-call context-insufficient rejection before model invocation/);
  assert.match(script, /evaluateAuditBundleBudget/);
  assert.match(script, /providerCalls: 0/);
  assert.match(script, /'CANDIDATE\.diff': diffEvidence\.text/);
  assert.match(script, /'DIFF_MANIFEST\.json'/);
  assert.doesNotMatch(script, /'CANDIDATE\.diff': compareEvidence\.diffText/);
});
