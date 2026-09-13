import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { main as auditMain } from '../scripts/run-delivery-v2-github-audit.mjs';

const auditWorkflow = await readFile(new URL('../.github/workflows/delivery-v2-audit.yml', import.meta.url), 'utf8');
const auditScript = await readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8');

test('independent auditor remains anchored to the trusted default branch', () => {
  assert.match(auditWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(auditWorkflow, /ref:\s*\$\{\{\s*inputs\.(?:target_ref|candidate|head)/);
});

test('audit runtime requiredEnv returns the validated value', () => {
  assert.equal(typeof auditMain, 'function');
  assert.match(auditScript, /function requiredEnv\(name\)[\s\S]*?if \(!value\) throw new Error\([\s\S]*?return value;/);
  assert.match(auditScript, /requiredEnv\('AUDIT_RISK_PROFILE'\)\.toLowerCase\(\)/);
});

test('total bundle budget is evaluated before any model invocation', () => {
  const budgetIndex = auditScript.indexOf('evaluateAuditBundleBudget');
  const runFreshIndex = auditScript.indexOf('executor.runFresh');
  assert.ok(budgetIndex >= 0);
  assert.ok(runFreshIndex > budgetIndex);
  assert.match(auditScript, /if \(!budget\.allowed\)/);
  assert.match(auditScript, /modelUsage: \{ providerCalls: 0 \}, providerCalls: 0/);
});

test('deterministic audit rejection carries zero-call identity into resumed telemetry input', () => {
  const failClosedIndex = auditScript.indexOf('if (!budget.allowed)');
  const modelIndex = auditScript.indexOf('executor.runFresh');
  assert.ok(failClosedIndex >= 0 && failClosedIndex < modelIndex);
  assert.match(auditScript.slice(failClosedIndex, modelIndex), /modelUsage: \{ providerCalls: 0 \}/);
  assert.match(auditScript.slice(failClosedIndex, modelIndex), /providerCalls: 0/);
});