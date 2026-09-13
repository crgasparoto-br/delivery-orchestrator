import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('normal dispatch owns initial and resumed controller paths through one idempotent controller entrypoint', async () => {
  const body = await readFile('.github/workflows/delivery-v2-dispatch.yml', 'utf8');
  assert.match(body, /node scripts\/guard-delivery-v2-reentry\.mjs/);
  assert.match(body, /node scripts\/reserve-delivery-v2-initial-attempt\.mjs/);
  assert.match(body, /node scripts\/run-delivery-v2-controller\.mjs/);
  assert.doesNotMatch(body, /run: node scripts\/resume-delivery-v2-controller\.mjs/);
  assert.match(body, /DELIVERY_V2_RESUME_PR:/);
  assert.match(body, /ORCHESTRATOR_WORKER_REF: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(body, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(body, /resume_pr == ''/);
  assert.match(body, /DELIVERY_V2_RESUME_PR: \$\{\{ steps\.reentry\.outputs\.resume_pr \}\}/);
  assert.match(body, /DELIVERY_V2_RECOVER_WORKER_RUN_ID:/);
  assert.equal((body.match(/node scripts\/run-delivery-v2-controller\.mjs/g) ?? []).length, 1);
  assert.match(body, /CONTROLLER_RESULT_PATH/);
  assert.match(body, /CONTROLLER_RESULT_PATH: \/tmp\/delivery-v2-controller-\$\{\{ github\.run_id \}\}\.json/);
  assert.doesNotMatch(body, /CONTROLLER_RESULT_PATH:[^\n]*runner\./);
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

test('trusted platform CI performs one strict completeness scan, one target scan and one automatic exact-head compile', async () => {
  const ci = await readFile('.github/workflows/delivery-v2-ci.yml', 'utf8');
  assert.equal((ci.match(/run: npm run verify:v2\s*(?:\n|$)/g) ?? []).length, 1);
  assert.doesNotMatch(ci, /run: npm run verify:v2:complete/);
  assert.match(ci, /gh aw compile --strict/);

  const compile = await readFile('.github/workflows/delivery-v2-gh-aw-compile.yml', 'utf8');
  assert.match(compile, /workflow_dispatch:/);
  assert.doesNotMatch(compile, /(?:^|\n)\s{2}(?:pull_request|push):/);
  assert.match(compile, /permissions:\n  contents: read/);
  assert.match(compile, /gh aw compile --strict/);
  assert.doesNotMatch(compile, /git push|contents: write/);

  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts['verify:v2'], 'npm run verify:v2:complete && npm run verify:v2:targets');
  assert.match(pkg.scripts['verify:v2:complete'], /verify-delivery-v2-completeness\.mjs --require-complete/);
  assert.match(pkg.scripts['verify:v2:targets'], /verify-delivery-v2-targets\.mjs/);
});

test('controller target policy binds each rollout repository to one stable required check, trusted workflow and explicit merge enforcement truth', async () => {
  const config = JSON.parse(await readFile('config/delivery-v2-controller-targets.json', 'utf8'));
  for (const [repository, target] of Object.entries(config.targets)) {
    assert.equal(target.finalStatusName, 'Delivery V2 release', repository);
    assert.equal(target.mergePolicy.requiredFinalStatusName, target.finalStatusName, repository);
    assert.equal(target.mergePolicy.enforcementMode, 'controller-status-only', repository);
    assert.equal(target.mergePolicy.nativeRequiredStatusEnforced, false, repository);
    assert.match(target.mergePolicy.limitation, /Native required-status enforcement is not configured/, repository);
  }
  assert.equal(config.targets['crgasparoto-br/controle_calorias'].requiredStatusName, 'Agent-first gate');
  assert.equal(config.targets['crgasparoto-br/controle_calorias'].ciWorkflowPath, '.github/workflows/agent-check.yml');
  assert.equal(config.targets['crgasparoto-br/training-system'].requiredStatusName, 'Validate repository');
  assert.equal(config.targets['crgasparoto-br/training-system'].ciWorkflowPath, '.github/workflows/validate-pr.yml');
});

test('initial and resumed controllers share persistent observability and the same metrics builder', async () => {
  const initial = await readFile('scripts/run-delivery-v2-controller.mjs', 'utf8');
  const resume = await readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8');
  for (const body of [initial, resume]) {
    assert.match(body, /createControllerDeliveryMetrics/);
    assert.match(body, /recordControllerProviderObservation/);
    assert.match(body, /observability/);
  }
  assert.match(resume, /metricsStatus: metrics \? 'complete' : 'partial-legacy-observability'/);
  assert.match(resume, /observedProviderCalls/);
  assert.match(resume, /partialMetrics/);
  assert.doesNotMatch(resume, /legacy-state-missing-observability/);
});
