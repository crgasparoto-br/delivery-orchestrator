import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateAuthorizationEnvelope } from '../.github/scripts/validate-delivery-v2-worker-authorization.mjs';

const SHA = 'a'.repeat(40);
const WORKFLOW = 'delivery-v2-worker-codex-critical.lock.yml';

function baseArgs(overrides = {}) {
  return {
    targetRepository: 'owner/repo',
    targetIssue: 76,
    targetPr: '',
    targetRef: 'main',
    baseBranch: 'main',
    provider: 'codex',
    model: 'model-a',
    riskProfile: 'critical',
    dispatchNonce: 'nonce-1',
    controllerRunId: 21,
    currentRunId: 22,
    expectedWorkflow: WORKFLOW,
    ...overrides
  };
}

function bootstrapEnvelope(model = 'model-a') {
  return {
    controllerRunId: 21,
    status: 'reserved-initial-attempt',
    repository: 'owner/repo',
    issueNumber: 76,
    baseBranch: 'main',
    provider: 'codex',
    model,
    requestedRisk: 'critical',
    effectiveRisk: 'critical',
    implementationAttempts: 1,
    dispatchNonce: 'nonce-1',
    workerWorkflow: WORKFLOW
  };
}

function remediationEnvelope(model = 'model-a') {
  return {
    persistent: {
      issueNumber: 76,
      pullRequestNumber: 77,
      repository: 'owner/repo',
      baseRef: 'main',
      provider: 'codex',
      model,
      effectiveRisk: 'critical',
      materialHeadSha: SHA
    },
    controller: {
      controllerRunId: 21,
      workerRunId: 22,
      nextAction: 'observe-remediation',
      workerDispatchNonce: 'nonce-1'
    }
  };
}

test('initial worker authorization rejects model drift before AI execution', () => {
  assert.doesNotThrow(() => validateAuthorizationEnvelope({
    envelope: bootstrapEnvelope('model-a'),
    ...baseArgs()
  }));
  assert.throws(() => validateAuthorizationEnvelope({
    envelope: bootstrapEnvelope('model-a'),
    ...baseArgs({ model: 'model-b' })
  }), /authorization model mismatch/);
});

test('remediation worker authorization rejects model drift before AI execution', () => {
  assert.doesNotThrow(() => validateAuthorizationEnvelope({
    envelope: remediationEnvelope('model-a'),
    ...baseArgs({ targetPr: '77', targetRef: SHA })
  }));
  assert.throws(() => validateAuthorizationEnvelope({
    envelope: remediationEnvelope('model-a'),
    ...baseArgs({ targetPr: '77', targetRef: SHA, model: 'model-b' })
  }), /persistent model mismatch/);
});

test('every worker authorizes the exact model expression executed by its engine', async () => {
  for (const provider of ['codex', 'claude', 'copilot']) {
    for (const risk of ['fast', 'standard', 'critical']) {
      const file = new URL(`../.github/workflows/delivery-v2-worker-${provider}-${risk}.md`, import.meta.url);
      const source = await readFile(file, 'utf8');
      const expected = source.match(/^\s+EXPECTED_MODEL:\s*(.+)$/m)?.[1]?.trim();
      const engine = source.match(/^\s{2}model:\s*(.+)$/m)?.[1]?.trim();
      assert.ok(expected, `${provider}/${risk} must authorize a model`);
      assert.ok(engine, `${provider}/${risk} must execute a model`);
      assert.equal(expected, engine, `${provider}/${risk} authorization and engine model expressions must match`);
    }
  }
});
