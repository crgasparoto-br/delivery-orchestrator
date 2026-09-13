import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_RESERVED_SEMANTIC_CATEGORIES,
  AUDIT_SEMANTIC_CATEGORY_ORDER,
  auditSemanticCategory,
  isActiveWorkerPromptAuditPath,
  isCanonicalDeliveryV2DocAuditPath,
  isGeneratedLowValueAuditPath
} from '../src/v2/audit-context-policy.mjs';

test('shared semantic policy classifies monorepo code, co-located tests and delivery control surfaces consistently', () => {
  const cases = new Map([
    ['apps/web/src/page.tsx', 'executable'],
    ['packages/core/index.ts', 'executable'],
    ['services/api/handler.py', 'executable'],
    ['apps/web/src/page.test.tsx', 'tests'],
    ['src/__tests__/controller.spec.mjs', 'tests'],
    ['config/delivery-v2-requirements.json', 'config'],
    ['.delivery-v2/lock.json', 'config'],
    ['package.json', 'config'],
    ['vite.config.ts', 'config'],
    ['docs/delivery-v2/evidence/dv2-013.json', 'evidence'],
    ['docs/delivery-v2/MASTER_SPEC.md', 'canonical-docs'],
    ['.github/workflows/delivery-v2-worker-codex-critical.md', 'prompts'],
    ['docs/changelog.md', 'docs'],
    ['assets/logo.bin', 'other']
  ]);

  for (const [filePath, expected] of cases) assert.equal(auditSemanticCategory(filePath), expected, filePath);
  assert.deepEqual(AUDIT_RESERVED_SEMANTIC_CATEGORIES, ['executable', 'tests', 'config', 'evidence', 'canonical-docs', 'prompts']);
  assert.deepEqual(AUDIT_SEMANTIC_CATEGORY_ORDER.slice(0, AUDIT_RESERVED_SEMANTIC_CATEGORIES.length), AUDIT_RESERVED_SEMANTIC_CATEGORIES);
});

test('specific audit identities win over generic path classes and generated exclusions stay explicit', () => {
  assert.equal(isActiveWorkerPromptAuditPath('.github/workflows/delivery-v2-worker-claude-fast.md'), true);
  assert.equal(auditSemanticCategory('.github/workflows/delivery-v2-worker-claude-fast.md'), 'prompts');
  assert.equal(auditSemanticCategory('.github/workflows/delivery-v2-ci.yml'), 'config');
  assert.equal(isCanonicalDeliveryV2DocAuditPath('docs/delivery-v2/AUDIT_CONTRACT.md'), true);
  assert.equal(auditSemanticCategory('docs/delivery-v2/AUDIT_CONTRACT.md'), 'canonical-docs');
  assert.equal(isGeneratedLowValueAuditPath('.github/workflows/delivery-v2-worker-codex-critical.lock.yml'), true);
  assert.equal(isGeneratedLowValueAuditPath('package-lock.json'), true);
  assert.equal(isGeneratedLowValueAuditPath('apps/web/src/page.tsx'), false);
});
