import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const auditWorkflow = await readFile(new URL('../.github/workflows/delivery-v2-audit.yml', import.meta.url), 'utf8');
const auditScript = await readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8');

test('independent auditor remains anchored to the trusted default branch', () => {
  assert.match(auditWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(auditWorkflow, /ref:\s*\$\{\{\s*inputs\.(?:target_ref|candidate|head)/);
});

test('total bundle budget is evaluated before any model invocation', () => {
  const budgetIndex = auditScript.indexOf('evaluateAuditBundleBudget');
  const runFreshIndex = auditScript.indexOf('executor.runFresh');
  assert.ok(budgetIndex >= 0);
  assert.ok(runFreshIndex > budgetIndex);
  assert.match(auditScript, /if \(!budget\.allowed\)/);
  assert.match(auditScript, /providerCalls: 0/);
});
