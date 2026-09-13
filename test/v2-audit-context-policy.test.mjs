import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditDiffLimitsForRisk,
  boundAuditDiff,
  DEFAULT_AUDIT_DIFF_LIMITS,
  STANDARD_AUDIT_DIFF_LIMITS
} from '../src/v2/bounded-audit-diff.mjs';
import {
  auditContextLimitsForRisk,
  DEFAULT_AUDIT_CONTEXT_LIMITS,
  fetchBoundedAuditContext,
  STANDARD_AUDIT_CONTEXT_LIMITS
} from '../src/v2/github-audit-evidence.mjs';

test('STANDARD audit context budget is half the CRITICAL aggregate byte ceiling', () => {
  const standardBytes = STANDARD_AUDIT_DIFF_LIMITS.maxTotalBytes + STANDARD_AUDIT_CONTEXT_LIMITS.maxTotalBytes;
  const criticalBytes = DEFAULT_AUDIT_DIFF_LIMITS.maxTotalBytes + DEFAULT_AUDIT_CONTEXT_LIMITS.maxTotalBytes;

  assert.equal(standardBytes, 80 * 1024);
  assert.equal(criticalBytes, 160 * 1024);
  assert.equal(standardBytes / criticalBytes, 0.5);
  assert.deepEqual(auditDiffLimitsForRisk('critical'), DEFAULT_AUDIT_DIFF_LIMITS);
  assert.deepEqual(auditContextLimitsForRisk('critical'), DEFAULT_AUDIT_CONTEXT_LIMITS);
});

test('audit context policy fails closed for unsupported risk profiles', () => {
  assert.throws(() => auditDiffLimitsForRisk('fast'), /unsupported audit diff risk profile/);
  assert.throws(() => auditContextLimitsForRisk('fast'), /unsupported audit context risk profile/);
});

test('AUDIT_RISK_PROFILE automatically selects STANDARD limits without weakening explicit test overrides', async (t) => {
  const previousRisk = process.env.AUDIT_RISK_PROFILE;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (previousRisk == null) delete process.env.AUDIT_RISK_PROFILE;
    else process.env.AUDIT_RISK_PROFILE = previousRisk;
    globalThis.fetch = originalFetch;
  });
  process.env.AUDIT_RISK_PROFILE = 'standard';

  const diff = 'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1 @@\n-a\n+b\n';
  const bounded = boundAuditDiff(diff, ['src/a.mjs']);
  assert.deepEqual(bounded.manifest.limits, STANDARD_AUDIT_DIFF_LIMITS);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        type: 'file',
        encoding: 'base64',
        sha: 'a'.repeat(40),
        content: Buffer.from('export const value = 1;\n').toString('base64')
      };
    },
    async text() { return ''; }
  });

  const context = await fetchBoundedAuditContext('owner/repo', 'b'.repeat(40), ['src/a.mjs'], 'token');
  assert.deepEqual(context.limits, STANDARD_AUDIT_CONTEXT_LIMITS);

  const explicit = boundAuditDiff(diff, ['src/a.mjs'], {
    limits: { maxFiles: 1, maxFileBytes: 128, maxTotalBytes: 128 }
  });
  assert.equal(explicit.manifest.limits.maxTotalBytes, 128);
});
