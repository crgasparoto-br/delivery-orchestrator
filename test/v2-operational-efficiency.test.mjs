import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('normal dispatch enters the bounded deterministic controller instead of dispatching one fire-and-forget worker', async () => {
  const body = await readFile('.github/workflows/delivery-v2-dispatch.yml', 'utf8');
  assert.match(body, /node scripts\/run-delivery-v2-controller\.mjs/);
  assert.match(body, /CONTROLLER_RESULT_PATH/);
  assert.doesNotMatch(body, /gh workflow run/);
  assert.match(body, /cancel-in-progress: false/);
});

test('generic audit is target/PR driven and no longer requires the issue-27 pilot marker', async () => {
  const body = await readFile('.github/workflows/delivery-v2-audit.yml', 'utf8');
  assert.match(body, /target_repository:/);
  assert.match(body, /target_pr:/);
  assert.match(body, /source_workflow_run_id:/);
  assert.match(body, /node scripts\/run-delivery-v2-github-audit\.mjs/);
  assert.doesNotMatch(body, /DV2-AUDIT-PILOT|TARGET_ISSUE: '27'/);
});

test('platform CI executes terminal completeness once and delegates gh-aw compilation to its dedicated exact-candidate workflow', async () => {
  const ci = await readFile('.github/workflows/delivery-v2-ci.yml', 'utf8');
  assert.equal((ci.match(/npm run verify:v2:complete/g) ?? []).length, 1);
  assert.doesNotMatch(ci, /npm run verify:v2\s*(?:\n|$)/);
  assert.doesNotMatch(ci, /gh aw compile/);

  const compile = await readFile('.github/workflows/delivery-v2-gh-aw-compile.yml', 'utf8');
  assert.match(compile, /pull_request:/);
  assert.match(compile, /permissions:\n  contents: read/);
  assert.match(compile, /gh aw compile --strict/);
  assert.doesNotMatch(compile, /git push|contents: write/);
});

test('controller target policy binds each rollout repository to one stable required check and trusted workflow', async () => {
  const config = JSON.parse(await readFile('config/delivery-v2-controller-targets.json', 'utf8'));
  assert.equal(config.targets['crgasparoto-br/controle_calorias'].requiredStatusName, 'Agent-first gate');
  assert.equal(config.targets['crgasparoto-br/controle_calorias'].ciWorkflowPath, '.github/workflows/agent-check.yml');
  assert.equal(config.targets['crgasparoto-br/training-system'].requiredStatusName, 'Validate repository');
  assert.equal(config.targets['crgasparoto-br/training-system'].ciWorkflowPath, '.github/workflows/validate-pr.yml');
});
