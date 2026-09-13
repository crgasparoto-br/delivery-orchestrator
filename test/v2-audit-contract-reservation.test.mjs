import assert from 'node:assert/strict';
import test from 'node:test';

import { AUDIT_RESERVED_SEMANTIC_CATEGORIES, auditSemanticCategory } from '../src/v2/audit-context-policy.mjs';
import { boundAuditDiff } from '../src/v2/bounded-audit-diff.mjs';

function block(path, payload = 'x'.repeat(200)) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${payload}\n+${payload}y\n`;
}

test('shared contract changes are a first-class reserved semantic class', () => {
  assert.ok(AUDIT_RESERVED_SEMANTIC_CATEGORIES.includes('contract'));
  for (const filePath of [
    'contracts/api.yaml',
    'schemas/public.json',
    'api/openapi.yaml',
    'proto/service.proto',
    'docs/schema.graphql'
  ]) {
    assert.equal(auditSemanticCategory(filePath), 'contract', filePath);
  }
});

test('executable spillover cannot evict a changed shared contract from the bounded diff', () => {
  const paths = [
    'src/heavy-a.mjs',
    'src/heavy-b.mjs',
    'test/heavy.test.mjs',
    'contracts/api.yaml',
    'config/runtime.json',
    'docs/delivery-v2/evidence/run.json',
    'docs/delivery-v2/MASTER_SPEC.md',
    '.github/workflows/delivery-v2-worker-codex-critical.md'
  ];
  const diff = paths.map((filePath, index) => block(filePath, String(index).repeat(300))).join('');
  const bounded = boundAuditDiff(diff, paths, {
    limits: { maxFiles: 7, maxFileBytes: 4096, maxTotalBytes: 16 * 1024 }
  });
  const included = new Set(bounded.manifest.included.map((entry) => entry.path));

  assert.equal(bounded.manifest.reservationCoverageComplete, true);
  assert.equal(bounded.manifest.requiredReservationCount, 7);
  assert.equal(bounded.manifest.categoryReservations.contract.required, true);
  assert.equal(bounded.manifest.categoryReservations.contract.path, 'contracts/api.yaml');
  assert.equal(bounded.manifest.categoryReservations.contract.included, true);
  assert.ok(included.has('contracts/api.yaml'));
  assert.equal([...included].filter((filePath) => filePath.startsWith('src/')).length, 1);
  assert.equal(bounded.manifest.omitted.find((entry) => entry.path.startsWith('src/'))?.reason, 'max-files');
});
