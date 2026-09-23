import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { boundAuditDiff } from '../src/v2/bounded-audit-diff.mjs';

function block(path, payload) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${payload}\n+${payload}x\n`;
}

test('bounded audit diff preserves full-diff identity while limiting model context', () => {
  const diff = [block('docs/readme.md', 'docs'), block('src/core.mjs', 'core')].join('');
  const changedPaths = ['docs/readme.md', 'src/core.mjs'];
  const bounded = boundAuditDiff(diff, changedPaths, {
    limits: { maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.fullDiffSha256, createHash('sha256').update(diff).digest('hex'));
  assert.equal(bounded.manifest.fullDiffBytes, Buffer.byteLength(diff));
  assert.equal(bounded.manifest.alignmentExact, true);
  assert.equal(bounded.manifest.contextReady, true);
  assert.equal(bounded.manifest.reservationCoverageComplete, true);
  assert.deepEqual(bounded.manifest.preflightReasons, []);
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

  assert.equal(bounded.manifest.contextReady, true);
  assert.ok(included.has('.github/workflows/delivery-v2-worker-codex-critical.md'));
  assert.ok(included.has('src/v2/controller-observability.mjs'));
  assert.ok(included.has('test/v2-controller-observability.test.mjs'));
  assert.equal(bounded.manifest.omitted.find((item) => item.path.endsWith('.lock.yml'))?.reason, 'generated-low-value');
});

test('semantic representatives survive realistic code-heavy blocks under the unchanged 64 KiB ceiling', () => {
  const paths = [
    ...Array.from({ length: 8 }, (_, index) => `apps/web/src/heavy-${index}.ts`),
    'apps/web/src/heavy.test.ts',
    'config/delivery-v2-requirements.json',
    'docs/delivery-v2/evidence/dv2-013-training-system-fast.json',
    'docs/delivery-v2/MASTER_SPEC.md',
    '.github/workflows/delivery-v2-worker-codex-critical.md'
  ];
  const payloads = paths.map((filePath) => filePath.includes('/heavy-') ? 'x'.repeat(2800) : 'y'.repeat(3800));
  const diff = paths.map((filePath, index) => block(filePath, payloads[index])).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 20, maxFileBytes: 12 * 1024, maxTotalBytes: 64 * 1024 }
  });
  const included = new Set(bounded.manifest.included.map((item) => item.path));

  assert.equal(bounded.manifest.contextReady, true);
  assert.ok([...included].some((filePath) => filePath.startsWith('apps/web/src/heavy-')));
  assert.ok(included.has('apps/web/src/heavy.test.ts'));
  assert.ok(included.has('config/delivery-v2-requirements.json'));
  assert.ok(included.has('docs/delivery-v2/evidence/dv2-013-training-system-fast.json'));
  assert.ok(included.has('docs/delivery-v2/MASTER_SPEC.md'));
  assert.ok(included.has('.github/workflows/delivery-v2-worker-codex-critical.md'));
  for (const category of ['executable', 'tests', 'config', 'evidence', 'canonical-docs', 'prompts']) {
    assert.equal(bounded.manifest.categoryReservations[category].included, true, `missing representative for ${category}`);
  }
  assert.ok(bounded.manifest.boundedBytes <= 64 * 1024);
});

test('semantic reservation byte overflow blocks the entire bounded context before spillover', () => {
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
  assert.equal(bounded.manifest.contextReady, false);
  assert.equal(bounded.manifest.reservationCoverageComplete, false);
  assert.ok(bounded.manifest.preflightReasons.includes('required-reservation-byte-limit-exceeded'));
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
  assert.equal(bounded.manifest.contextReady, false);
  assert.ok(bounded.manifest.preflightReasons.includes('required-category-no-eligible-representative:executable'));
  assert.equal(bounded.manifest.included.length, 0);
  assert.equal(bounded.manifest.omitted[0].reason, 'max-file-bytes');
});

test('required semantic reservations fail closed when maxFiles cannot represent all present classes', () => {
  const paths = ['apps/web/src/page.tsx', 'apps/web/src/page.test.tsx'];
  const diff = paths.map((filePath) => block(filePath, 'x'.repeat(100))).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 8192 }
  });

  assert.equal(bounded.manifest.requiredReservationCount, 2);
  assert.equal(bounded.manifest.contextReady, false);
  assert.ok(bounded.manifest.preflightReasons.includes('required-reservation-file-limit-exceeded'));
  assert.equal(bounded.manifest.included.length, 0);
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
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 12, maxFileBytes: 4096, maxTotalBytes: 8 * 1024 }
  });
  const included = new Set(bounded.manifest.included.map((item) => item.path));

  assert.equal(bounded.manifest.contextReady, true);
  assert.equal(bounded.manifest.categoryReservations['canonical-docs'].path, 'docs/delivery-v2/MASTER_SPEC.md');
  assert.equal(bounded.manifest.categoryReservations['canonical-docs'].included, true);
  assert.equal(bounded.manifest.categoryReservations.docs.required, false);
  assert.ok(included.has('docs/delivery-v2/MASTER_SPEC.md'));
  assert.equal(bounded.manifest.included.find((item) => item.path === 'docs/delivery-v2/MASTER_SPEC.md')?.category, 'canonical-docs');
});

test('co-located tests under arbitrary monorepo roots receive the tests reservation', () => {
  const paths = ['apps/web/src/controller.ts', 'apps/web/src/controller.test.ts'];
  const diff = paths.map((filePath) => block(filePath, 'x'.repeat(400))).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.contextReady, true);
  assert.equal(bounded.manifest.included.find((item) => item.path === 'apps/web/src/controller.test.ts')?.category, 'tests');
  assert.equal(bounded.manifest.categoryReservations.tests.path, 'apps/web/src/controller.test.ts');
  assert.equal(bounded.manifest.categoryReservations.executable.path, 'apps/web/src/controller.ts');
});

test('diff blocks bind to their own headers even when GitHub changed-path order differs', () => {
  const diff = [block('src/a.mjs', 'a'), block('src/b.mjs', 'b')].join('');
  const bounded = boundAuditDiff(diff, ['src/b.mjs', 'src/a.mjs'], {
    limits: { maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 4096 }
  });

  assert.equal(bounded.manifest.alignmentExact, true);
  assert.equal(bounded.manifest.contextReady, true);
  assert.deepEqual(bounded.manifest.included.map((item) => item.path), ['src/a.mjs']);
  assert.deepEqual(bounded.manifest.omitted.map((item) => item.path), ['src/b.mjs']);
});

test('add, delete, rename, copy, mode-only, binary, quoted-space and C-quoted paths retain exact identity', () => {
  const cases = [
    {
      path: 'src/added.mjs',
      diff: 'diff --git a/src/added.mjs b/src/added.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/src/added.mjs\n@@ -0,0 +1 @@\n+new\n'
    },
    {
      path: 'src/deleted.mjs',
      diff: 'diff --git a/src/deleted.mjs b/src/deleted.mjs\ndeleted file mode 100644\n--- a/src/deleted.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
    },
    {
      path: 'src/new-name.mjs',
      diff: 'diff --git a/src/old-name.mjs b/src/new-name.mjs\nsimilarity index 100%\nrename from src/old-name.mjs\nrename to src/new-name.mjs\n'
    },
    {
      path: 'src/copied.mjs',
      diff: 'diff --git a/src/original.mjs b/src/copied.mjs\nsimilarity index 100%\ncopy from src/original.mjs\ncopy to src/copied.mjs\n'
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
      path: 'docs/file name.md',
      diff: 'diff --git "a/docs/file name.md" "b/docs/file name.md"\nold mode 100644\nnew mode 100755\n'
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
    assert.equal(bounded.manifest.contextReady, true, current.path);
    assert.equal(bounded.manifest.included[0]?.path, current.path);
  }
});

test('unverified, malformed or duplicate diff identity returns a blocked manifest with no candidate bytes', () => {
  const mismatched = boundAuditDiff([block('src/a.mjs', 'a'), block('src/b.mjs', 'b')].join(''), ['src/a.mjs', 'src/c.mjs'], {
    limits: { maxFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192 }
  });
  assert.equal(mismatched.manifest.alignmentExact, false);
  assert.equal(mismatched.manifest.contextReady, false);
  assert.deepEqual(mismatched.manifest.preflightReasons, ['path-alignment-unproven']);
  assert.equal(mismatched.text, '');
  assert.equal(mismatched.manifest.included.length, 0);
  assert.ok(mismatched.manifest.omitted.every((item) => item.reason === 'unverified-path-alignment'));

  const malformed = boundAuditDiff('diff --git "a/src/bad\\q.mjs" "b/src/bad\\q.mjs"\nold mode 100644\nnew mode 100755\n', ['src/badq.mjs']);
  assert.equal(malformed.manifest.contextReady, false);
  assert.ok(malformed.manifest.preflightReasons.includes('path-alignment-unproven'));

  const duplicatePaths = boundAuditDiff([block('src/a.mjs', 'a'), block('src/b.mjs', 'b')].join(''), ['src/a.mjs', 'src/a.mjs']);
  assert.equal(duplicatePaths.manifest.contextReady, false);
  assert.equal(duplicatePaths.manifest.included.length, 0);
});

test('oversized required diff blocks are explicit and cannot reach a ready context', () => {
  const diff = block('src/large.mjs', 'x'.repeat(200));
  const bounded = boundAuditDiff(diff, ['src/large.mjs'], {
    limits: { maxFiles: 2, maxFileBytes: 64, maxTotalBytes: 128 }
  });

  assert.equal(bounded.text, '');
  assert.equal(bounded.manifest.included.length, 0);
  assert.equal(bounded.manifest.omitted[0].path, 'src/large.mjs');
  assert.equal(bounded.manifest.omitted[0].reason, 'max-file-bytes');
  assert.equal(bounded.manifest.contextReady, false);
  assert.ok(bounded.manifest.preflightReasons.includes('required-category-no-eligible-representative:executable'));
});

test('GitHub-native auditor uses one deterministic preflight barrier before supplemental reads and model invocation', async () => {
  const script = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8'));
  assert.match(script, /const diffPreflightReasons = boundedDiffPreflightReasons\(diffEvidence\.manifest\)/);
  assert.match(script, /required-reservation-not-included:\$\{category\}/);
  assert.match(script, /context-readiness-unproven/);
  assert.match(script, /const materialContext = boundedPreflightReasons\.length === 0[\s\S]*?fetchBoundedAuditContext[\s\S]*?: blockedMaterialContext/);
  assert.match(script, /blocked-before-supplemental-context-fetch/);
  assert.match(script, /preflightReasons: boundedPreflightReasons/);
  assert.match(script, /preflightReasons: diffEvidence\.manifest\.preflightReasons/);
  assert.doesNotMatch(script, /throw new Error\('audit diff path alignment could not be proven/);
  assert.match(script, /providerCalls: 0/);
  assert.match(script, /'CANDIDATE\.diff': diffEvidence\.text/);
  assert.doesNotMatch(script, /'CANDIDATE\.diff': compareEvidence\.diffText/);
});

test('GitHub-native audit prompt explicitly accepts complete exact-SHA chunked material', async () => {
  const script = await import('node:fs/promises').then(
    ({ readFile }) =>
      readFile(
        new URL(
          '../scripts/run-delivery-v2-github-audit.mjs',
          import.meta.url
        ),
        'utf8'
      )
  );

  assert.match(
    script,
    /MATERIAL_CONTEXT\.json may represent a large exact-SHA text file as ordered chunks/
  );

  assert.match(
    script,
    /contiguous byte coverage from 0 through fileBytes/
  );

  assert.match(
    script,
    /A fully covered chunked file is represented material, not omitted context/
  );

  assert.match(
    script,
    /chunkCount: materialContext\.chunks\?\.length/
  );
});
