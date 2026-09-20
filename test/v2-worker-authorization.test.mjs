import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  expectedWorkerWorkflow,
  validateAuthorizationEnvelope,
  validateControllerRun,
  validateCurrentWorkerRun,
  validateUniqueCorrelatedWorkerRun
} from '../.github/scripts/validate-delivery-v2-worker-authorization.mjs';

const controllerRun = {
  id: 700,
  path: '.github/workflows/delivery-v2-dispatch.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  status: 'in_progress',
  display_title: 'Delivery V2 controller crgasparoto-br/example #42'
};
const workerRun = {
  id: 701,
  path: '.github/workflows/delivery-v2-worker-codex-standard.lock.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  display_title: 'Delivery V2 worker nonce-1'
};

function remediationEnvelope(overrides = {}) {
  return {
    persistent: {
      repository: 'crgasparoto-br/example', issueNumber: 42, pullRequestNumber: 88,
      baseRef: 'main', provider: 'codex', effectiveRisk: 'standard',
      materialHeadSha: 'a'.repeat(40),
      ...overrides.persistent
    },
    controller: {
      controllerRunId: 700, workerRunId: 701, workerDispatchNonce: 'nonce-1', nextAction: 'observe-remediation',
      ...overrides.controller
    }
  };
}

const authInput = {
  targetRepository: 'crgasparoto-br/example', targetIssue: 42, targetPr: '88', targetRef: 'a'.repeat(40),
  baseBranch: 'main', provider: 'codex', riskProfile: 'standard', dispatchNonce: 'nonce-1',
  controllerRunId: 700, currentRunId: 701, expectedWorkflow: 'delivery-v2-worker-codex-standard.lock.yml'
};

test('controller and current worker identities are exact', () => {
  assert.equal(validateControllerRun(controllerRun, { controllerRunId: 700, targetRepository: 'crgasparoto-br/example', targetIssue: 42, defaultBranch: 'main' }), true);
  assert.equal(validateCurrentWorkerRun(workerRun, { currentRunId: 701, expectedWorkflow: expectedWorkerWorkflow('codex', 'standard'), dispatchNonce: 'nonce-1', defaultBranch: 'main' }), true);
  assert.throws(() => validateCurrentWorkerRun({ ...workerRun, path: '.github/workflows/delivery-v2-worker-claude-critical.lock.yml' }, { currentRunId: 701, expectedWorkflow: expectedWorkerWorkflow('codex', 'standard'), dispatchNonce: 'nonce-1', defaultBranch: 'main' }), /workflow identity mismatch/);
});

test('initial worker authorization binds provider risk workflow nonce ref and initial mode', () => {
  const envelope = {
    repository: 'crgasparoto-br/example', issueNumber: 42, baseBranch: 'main', provider: 'codex', effectiveRisk: 'standard',
    controllerRunId: 700, status: 'reserved-initial-attempt', workerWorkflow: 'delivery-v2-worker-codex-standard.lock.yml', dispatchNonce: 'nonce-1'
  };
  const result = validateAuthorizationEnvelope({ ...authInput, targetPr: '', targetRef: 'main', envelope });
  assert.equal(result.mode, 'initial');
  assert.throws(() => validateAuthorizationEnvelope({ ...authInput, targetPr: '', targetRef: 'main', provider: 'claude', envelope }), /provider mismatch/);
  assert.throws(() => validateAuthorizationEnvelope({ ...authInput, targetPr: '', targetRef: 'main', dispatchNonce: 'other', envelope }), /nonce mismatch/);
});

test('remediation authorization binds exact PR head worker run and active action', () => {
  const result = validateAuthorizationEnvelope({ ...authInput, envelope: remediationEnvelope() });
  assert.equal(result.mode, 'remediation');
  assert.equal(result.pullRequestNumber, 88);
  assert.throws(() => validateAuthorizationEnvelope({ ...authInput, currentRunId: 702, envelope: remediationEnvelope() }), /worker run mismatch/);
  assert.throws(() => validateAuthorizationEnvelope({ ...authInput, targetPr: '89', envelope: remediationEnvelope() }), /persistent PR mismatch/);
  assert.throws(() => validateAuthorizationEnvelope({ ...authInput, targetRef: 'b'.repeat(40), envelope: remediationEnvelope() }), /target_ref mismatch/);
  assert.throws(() => validateAuthorizationEnvelope({ ...authInput, envelope: remediationEnvelope({ controller: { nextAction: 'dispatch-remediation' } }) }), /not the active authorized action/);
});

test('technical hygiene authorization binds hygiene run nonce and active action', () => {
  const envelope = remediationEnvelope({
    controller: {
      workerRunId: null,
      workerDispatchNonce: null,
      nextAction: 'observe-technical-hygiene',
      hygieneRunId: 701,
      hygieneDispatchNonce: 'nonce-1'
    }
  });

  const result = validateAuthorizationEnvelope({ ...authInput, envelope });
  assert.equal(result.mode, 'technical-hygiene');
  assert.equal(result.workerRunId, 701);
  assert.equal(result.pullRequestNumber, 88);

  assert.throws(
    () => validateAuthorizationEnvelope({
      ...authInput,
      currentRunId: 702,
      envelope
    }),
    /technical-hygiene worker run mismatch/
  );

  assert.throws(
    () => validateAuthorizationEnvelope({
      ...authInput,
      dispatchNonce: 'other',
      envelope
    }),
    /technical-hygiene nonce mismatch/
  );

  assert.throws(
    () => validateAuthorizationEnvelope({
      ...authInput,
      envelope: remediationEnvelope({
        controller: {
          workerRunId: null,
          workerDispatchNonce: null,
          nextAction: 'technical-hygiene-worker-failed',
          hygieneRunId: 701,
          hygieneDispatchNonce: 'nonce-1'
        }
      })
    }),
    /not the active authorized action/
  );
});

test('correlated worker run must be unique and current', () => {
  assert.equal(validateUniqueCorrelatedWorkerRun([workerRun], { currentRunId: 701, dispatchNonce: 'nonce-1', defaultBranch: 'main' }), true);
  assert.throws(() => validateUniqueCorrelatedWorkerRun([workerRun, { ...workerRun, id: 702 }], { currentRunId: 701, dispatchNonce: 'nonce-1', defaultBranch: 'main' }), /exactly one correlated run/);
});

test('all provider/risk worker sources bootstrap and delegate authorization to one deterministic guard', async () => {
  for (const provider of ['copilot', 'codex', 'claude']) {
    for (const risk of ['fast', 'standard', 'critical']) {
      const body = await readFile(`.github/workflows/delivery-v2-worker-${provider}-${risk}.md`, 'utf8');
      const checkoutIndex = body.indexOf('- name: Checkout trusted authorization guard');
      const validationIndex = body.indexOf('- name: Validate controller-selected worker authorization');
      assert.notEqual(checkoutIndex, -1, `${provider}/${risk} must checkout the trusted authorization guard`);
      assert.notEqual(validationIndex, -1, `${provider}/${risk} must validate worker authorization`);
      assert.ok(checkoutIndex < validationIndex, `${provider}/${risk} must checkout the guard before validation`);
      assert.match(body, /repository: \$\{\{ github\.repository \}\}/);
      assert.match(body, /ref: \$\{\{ github\.sha \}\}/);
      assert.match(body, /path: \.delivery-v2-control-plane/);
      assert.match(body, /sparse-checkout: \.github\/scripts\/validate-delivery-v2-worker-authorization\.mjs/);
      assert.match(body, /persist-credentials: false/);
      assert.match(body, /trap 'rm -rf \.delivery-v2-control-plane' EXIT/);
      assert.match(body, /node \.delivery-v2-control-plane\/\.github\/scripts\/validate-delivery-v2-worker-authorization\.mjs/);
      assert.match(body, new RegExp(`EXPECTED_PROVIDER: ${provider}`));
      assert.match(body, new RegExp(`EXPECTED_RISK: ${risk}`));
      assert.match(body, /TARGET_PR: \$\{\{ github\.event\.inputs\.target_pr \}\}/);
      assert.match(body, /TARGET_REF: \$\{\{ github\.event\.inputs\.target_ref \|\| github\.event\.inputs\.base_branch \}\}/);
      assert.doesNotMatch(body, /node <<'PROVENANCE'/);
    }
  }
});
