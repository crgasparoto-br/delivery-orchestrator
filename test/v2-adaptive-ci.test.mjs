import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCiPlan } from '../src/v2/ci-plan.mjs';

test('FAST web component stays fast and avoids full PR regression', () => {
  const plan = buildCiPlan({
    requested: 'auto',
    changedPaths: ['apps/web/src/components/Filters.tsx']
  });
  assert.equal(plan.riskProfile, 'fast');
  assert.equal(plan.ciMode, 'focused');
  assert.equal(plan.auditRequired, false);
  assert.equal(plan.fullRegressionOnPr, false);
  assert.equal(plan.fullRegressionAfterMerge, true);
  assert.deepEqual(plan.stages, {
    lint: 'affected', typecheck: 'affected', tests: 'focused', build: 'affected'
  });
});

test('requesting fast cannot downgrade a migration change', () => {
  const plan = buildCiPlan({
    requested: 'fast',
    changedPaths: ['apps/api/prisma/migrations/20260911_add_field/migration.sql']
  });
  assert.equal(plan.riskProfile, 'critical');
  assert.equal(plan.promoted, true);
  assert.equal(plan.fullRegressionOnPr, true);
  assert.equal(plan.auditRequired, true);
});

test('unknown path fails closed to critical', () => {
  const plan = buildCiPlan({ requested: 'auto', changedPaths: ['tooling/new-surface.xyz'] });
  assert.equal(plan.riskProfile, 'critical');
  assert.match(plan.reasons.join(' '), /unknown-path/);
});

test('explicit standard is preserved for otherwise fast files', () => {
  const plan = buildCiPlan({ requested: 'standard', changedPaths: ['docs/delivery-note.md'] });
  assert.equal(plan.riskProfile, 'standard');
  assert.equal(plan.promoted, false);
  assert.equal(plan.ciMode, 'affected-plus-build');
});

test('adaptive CI reusable workflow exposes deterministic outputs without AI execution', async () => {
  const body = await readFile('.github/workflows/delivery-v2-classify-ci.yml', 'utf8');
  assert.match(body, /workflow_call:/);
  for (const output of [
    'risk_profile', 'ci_mode', 'audit_required', 'audit_mode',
    'full_regression_on_pr', 'full_regression_after_merge',
    'promoted', 'changed_paths_json', 'reasons_json'
  ]) assert.match(body, new RegExp(`${output}:`));
  assert.match(body, /actions\/delivery-v2-risk@main/);
  assert.doesNotMatch(body, /gh-aw|codex|claude|copilot/i);
});

test('risk action is dependency-free and delegates policy to the V2 source of truth', async () => {
  const metadata = await readFile('actions/delivery-v2-risk/action.yml', 'utf8');
  const source = await readFile('actions/delivery-v2-risk/index.cjs', 'utf8');
  assert.match(metadata, /using: node20/);
  assert.match(source, /pulls\/\$\{pullRequestNumber\}\/files/);
  assert.match(source, /\.\.\/\.\.\/src\/v2\/ci-plan\.mjs/);
  assert.doesNotMatch(source, /child_process|execSync|spawnSync/);
});
