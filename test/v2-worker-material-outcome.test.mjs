import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  classifySuccessfulWorkerOutcome,
  continueAfterSuccessfulWorkerOutcome
} from '../src/v2/worker-material-outcome.mjs';

test('issue 301: non-material success never invokes a material-effect waiter', async () => {
  for (const type of ['noop', 'report_incomplete', 'missing_tool', 'missing_data']) {
    let waits = 0;
    const result = await continueAfterSuccessfulWorkerOutcome({
      evidence: {
        hasPatch: false,
        agentOutput: { items: [{ type, reason: 'no material produced' }], errors: [] },
        evidenceRef: `artifact:${type}`
      },
      waitForMaterialHead: async () => {
        waits += 1;
        return { head: { sha: 'unexpected' } };
      }
    });
    assert.equal(waits, 0);
    assert.equal(result.workerOutcome.action, 'blocked-no-material');
    assert.equal(result.pullRequest, null);
  }
});

test('issue 301: a patch waits for repository effect and ambiguous evidence fails closed', async () => {
  let waits = 0;
  const result = await continueAfterSuccessfulWorkerOutcome({
    evidence: { hasPatch: true, agentOutput: { items: [], errors: [] }, evidenceRef: 'artifact:patch' },
    waitForMaterialHead: async () => {
      waits += 1;
      return { head: { sha: 'a'.repeat(40) } };
    }
  });
  assert.equal(waits, 1);
  assert.equal(result.workerOutcome.action, 'await-material-head');
  assert.equal(classifySuccessfulWorkerOutcome({ hasPatch: null, agentOutput: { items: [], errors: [] } }).action, 'fail-closed');
  assert.equal(classifySuccessfulWorkerOutcome({ hasPatch: true, agentOutput: null }).action, 'fail-closed');
});

test('issue 301: initial, CI remediation, audit remediation and resume share one material contract', async () => {
  const run = await readFile(new URL('../scripts/run-delivery-v2-controller.mjs', import.meta.url), 'utf8');
  const resume = await readFile(new URL('../scripts/resume-delivery-v2-controller.mjs', import.meta.url), 'utf8');

  assert.match(run, /worker-material-outcome\.mjs/);
  assert.match(resume, /worker-material-outcome\.mjs/);
  assert.doesNotMatch(resume, /const NO_MATERIAL_SAFE_OUTPUT_TYPES/);

  const initialStart = run.indexOf('for (;;) {');
  const initialEnd = run.indexOf('let pullRequest = await findManagedPullRequest', initialStart);
  const initial = run.slice(initialStart, initialEnd);
  assert.match(initial, /recordInitialWorkerCorrelation/);
  assert.ok(initial.indexOf('recordInitialWorkerCorrelation') < initial.indexOf('waitWorkflowRun'));
  assert.match(initial, /classifySuccessfulWorkerOutcome/);

  const ciStart = run.indexOf("if (ciConclusion !== 'success')");
  const ciEnd = run.indexOf("if (!latestSourceRun)", ciStart);
  const ci = run.slice(ciStart, ciEnd);
  assert.match(ci, /continueAfterSuccessfulWorkerOutcome/);
  assert.ok(ci.indexOf('continueAfterSuccessfulWorkerOutcome') < ci.indexOf('waitHeadChange'));

  const auditStart = run.indexOf("if (state.status === 'audit-failed-remediable')");
  const auditEnd = run.indexOf("if (state.status === 'technical-hygiene-pending')", auditStart);
  const audit = run.slice(auditStart, auditEnd);
  assert.match(audit, /continueAfterSuccessfulWorkerOutcome/);
  assert.ok(audit.indexOf('continueAfterSuccessfulWorkerOutcome') < audit.indexOf('waitHeadChange'));
});

test('issue 301: policy state counters bound progress without the old eight-cycle ceiling', async () => {
  for (const path of [
    '../scripts/run-delivery-v2-controller.mjs',
    '../scripts/resume-delivery-v2-controller.mjs'
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /cycle\s*<\s*8/);
    assert.match(source, /while \(!\['ready-for-human-merge', 'escalated', 'terminal'\]\.includes\(state\.status\)\)/);
  }
});

test('issue 301: restricted Codex PATH includes rm in host staging and effective runtime preflight', async () => {
  const host = await readFile(new URL('../.github/scripts/ensure-delivery-v2-worker-sandbox-toolchain.mjs', import.meta.url), 'utf8');
  const wrapper = await readFile(new URL('../.github/scripts/run-delivery-v2-codex-with-sandbox-preflight.sh', import.meta.url), 'utf8');
  assert.match(host, /'rm'/);
  assert.match(wrapper, /require_tool rm/);
  assert.match(wrapper, /command -v rm/);
  assert.match(wrapper, /rm --version/);
  assert.match(wrapper, /for tool in bash cat gh git sed sh sort node npm pnpm rm safeoutputs/);
});
