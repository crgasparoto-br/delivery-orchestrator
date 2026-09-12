import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function evidence() {
  return JSON.parse(await readFile(new URL('../docs/delivery-v2/evidence/dv2-013-training-system-fast.json', import.meta.url), 'utf8'));
}

test('DV2-013 evidence binds the real training-system FAST pilot to exact-head CI and artifact data', async () => {
  const value = await evidence();
  const pilot = value.fastPilot;

  assert.equal(value.requirement, 'DV2-013');
  assert.equal(value.repository, 'crgasparoto-br/training-system');
  assert.equal(pilot.pullRequestNumber, 436);
  assert.equal(pilot.materialHeadSha, 'ed59660e0a5cbe8b202491b105e36614770dfac6');
  assert.deepEqual(pilot.changedFiles, ['apps/web/src/components/AppErrorBoundary.tsx']);
  assert.equal(pilot.classification.effectiveRisk, 'fast');
  assert.equal(pilot.classification.promoted, false);
  assert.equal(pilot.classification.apiChanged, false);
  assert.equal(pilot.classification.databaseRequired, false);
  assert.equal(pilot.workflow.workflowRunId, 34693145142);
  assert.equal(pilot.workflow.conclusion, 'success');
  assert.equal(pilot.exactHeadArtifact.payload.headSha, pilot.materialHeadSha);
  assert.equal(pilot.exactHeadArtifact.payload.checkoutSha, pilot.materialHeadSha);
  assert.equal(pilot.exactHeadArtifact.payload.baseSha, pilot.baseSha);
  assert.equal(pilot.exactHeadArtifact.payload.riskProfile, 'fast');
  assert.equal(pilot.exactHeadArtifact.digest, 'sha256:bc7c2382e4a941a86b271ff6c56ae12db0cfc550a2c1ec736b4b8dadd074298a');
});

test('DV2-013 FAST routing executed focused web gates and skipped STANDARD/CRITICAL validation', async () => {
  const value = await evidence();
  const jobs = value.fastPilot.workflow.jobs;

  assert.equal(jobs.risk.conclusion, 'success');
  assert.equal(jobs.mergePreview.conclusion, 'success');
  assert.equal(jobs.fastValidation.conclusion, 'success');
  assert.equal(jobs.standardValidation.conclusion, 'skipped');
  assert.equal(jobs.criticalValidation.conclusion, 'skipped');
  assert.equal(jobs.aggregate.conclusion, 'success');
  assert.ok(jobs.mergePreview.skippedSteps.includes('Run pnpm --filter @corrida/api exec prisma generate'));
  assert.ok(jobs.mergePreview.skippedSteps.includes('STANDARD or CRITICAL type compatibility'));
  assert.ok(jobs.fastValidation.successfulSteps.includes('FAST related tests'));
  assert.ok(jobs.fastValidation.successfulSteps.includes('Web build'));
  assert.ok(jobs.fastValidation.successfulSteps.includes('Architecture checks'));
  assert.deepEqual(jobs.fastValidation.skippedSteps, ['Documentation checks']);
});

test('DV2-013 benchmark preserves measured timings and does not overclaim rollout or prior audit disposition', async () => {
  const value = await evidence();
  const benchmark = value.fastPilot.benchmark;

  assert.equal(value.migration.criticalWorkflowEndToEndSeconds, 993);
  assert.equal(value.fastPilot.workflow.endToEndSeconds, 164);
  assert.equal(value.fastPilot.workflow.jobs.fastValidation.executionSeconds, 74);
  assert.equal(value.fastPilot.workflow.jobs.fastValidation.queueSeconds, 38);
  assert.equal(benchmark.baselineEndToEndSeconds, 993);
  assert.equal(benchmark.fastEndToEndSeconds, 164);
  assert.equal(benchmark.observedReductionPercent, 83.48);
  assert.equal(benchmark.observedSpeedup, 6.05);
  assert.match(benchmark.comparisonBoundary, /not an apples-to-apples workload comparison/);

  assert.equal(value.priorAuditDisposition.persistedIndependentFindingsFound, false);
  assert.equal(value.priorAuditDisposition.disposition, 'no-machine-verifiable-pr435-independent-finding-was-persisted');
  assert.match(value.priorAuditDisposition.claimBoundary, /does not relabel an unavailable prior audit as approved or resolved/);

  assert.equal(value.fastPilot.merged, false);
  assert.equal(value.fastPilot.humanDisposition.mergePerformedByController, false);
  assert.equal(value.statusDecision.status, 'validated');
  assert.equal(value.statusDecision.rolledOut, false);
});
