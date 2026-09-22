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

import {
  resumeEntryNextAction,
  shouldRearmFailedTechnicalHygiene,
  shouldRearmUnknownTechnicalHygiene
} from '../scripts/resume-delivery-v2-controller.mjs';

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

test('technical hygiene promotion persists exact authorization before waiting for the worker', async () => {
  for (const path of [
    'scripts/run-delivery-v2-controller.mjs',
    'scripts/resume-delivery-v2-controller.mjs'
  ]) {
    const body = await readFile(path, 'utf8');

    const calls = (body.match(/await ensurePromotedTechnicalHygiene\(\{/g) ?? []).length;
    const callbacks = (body.match(/authorizePromotion: async/g) ?? []).length;

    assert.ok(calls > 0, `${path} must contain technical hygiene promotion calls`);
    assert.equal(callbacks, calls, `${path} must authorize every promotion dispatch`);

    assert.match(body, /nextAction: phase === 'observe'[\s\S]*?'observe-technical-hygiene'[\s\S]*?'dispatch-technical-hygiene'/);
    assert.match(body, /hygieneDispatchNonce: dispatchNonce/);
    assert.match(body, /hygieneRunId: runId/);

    const observeAuthorization = body.indexOf("phase: 'observe'");
    const waitForWorker = body.indexOf(
      'promotionRun = await waitWorkflowRun(orchestratorRepository, promotionRun.id, actionsToken)'
    );

    assert.ok(observeAuthorization >= 0, `${path} must persist observe authorization`);
    assert.ok(waitForWorker >= 0, `${path} must wait for promotion worker`);
    assert.ok(
      observeAuthorization < waitForWorker,
      `${path} must persist exact hygiene run authorization before waiting`
    );
  }
});


test('failed technical hygiene rearms only after a control-plane change', () => {
  const previousControllerSha = 'a'.repeat(40);
  const currentControllerSha = 'b'.repeat(40);

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'technical-hygiene-worker-failed',
      runConclusion: 'failure',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    true
  );

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'technical-hygiene-worker-failed',
      runConclusion: 'failure',
      runHeadSha: currentControllerSha,
      currentControllerSha
    }),
    false,
    'the same control-plane SHA must not create an automatic retry loop'
  );

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'observe-technical-hygiene',
      runConclusion: 'failure',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    false,
    'only the persisted terminal failure state may be rearmed'
  );

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'technical-hygiene-worker-failed',
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    false,
    'a successful worker must never be replaced'
  );

  assert.equal(
    shouldRearmFailedTechnicalHygiene({
      nextAction: 'technical-hygiene-worker-failed',
      runConclusion: 'failure',
      runHeadSha: '',
      currentControllerSha
    }),
    false,
    'missing provenance must fail closed'
  );
});

test('UNKNOWN technical hygiene rearms only for stale toolchain evidence after control-plane change', () => {
  const previousControllerSha = 'a'.repeat(40);
  const currentControllerSha = 'b'.repeat(40);

  const toolchainUnknown = {
    result: 'UNKNOWN',
    missingEvidence: [
      {
        code: 'VALIDATION_TOOLCHAIN_MISSING',
        detail: 'validation tools were unavailable',
        material: true
      }
    ]
  };

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: toolchainUnknown,
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    true,
    'toolchain UNKNOWN from an older control plane must be recollected'
  );

  const historicalToolchainUnknown = {
    result: 'UNKNOWN',
    missingEvidence: [
      {
        code: 'SAFEOUTPUTS_UNAVAILABLE',
        detail: 'safeoutputs transport was unavailable in the previous worker',
        material: true
      },
      {
        code: 'LOCAL_DEPENDENCIES_UNAVAILABLE',
        detail: 'local dependencies could not be materialized in the previous worker',
        material: true
      }
    ]
  };

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: historicalToolchainUnknown,
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    true,
    'historical infrastructure UNKNOWN evidence must be recollected after a control-plane change'
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: toolchainUnknown,
      runConclusion: 'success',
      runHeadSha: currentControllerSha,
      currentControllerSha
    }),
    false,
    'the same control-plane SHA must not create an automatic retry loop'
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: {
        result: 'UNKNOWN',
        missingEvidence: [
          {
            code: 'SEMANTIC_EQUIVALENCE_UNKNOWN',
            detail: 'semantic equivalence was not proven',
            material: true
          }
        ]
      },
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    false,
    'semantic UNKNOWN must remain release-blocking'
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: {
        result: 'UNKNOWN',
        missingEvidence: [
          {
            code: 'VALIDATION_TOOLCHAIN_MISSING',
            detail: 'validation tools were unavailable',
            material: true
          },
          {
            code: 'SEMANTIC_EQUIVALENCE_UNKNOWN',
            detail: 'semantic equivalence was not proven',
            material: true
          }
        ]
      },
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    false,
    'mixed toolchain and semantic material UNKNOWN must remain release-blocking'
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: {
        result: 'UNKNOWN',
        missingEvidence: [
          {
            code: 'VALIDATION_TOOLCHAIN_MISSING',
            detail: 'validation tools were unavailable',
            material: true
          },
          {
            code: 'SEMANTIC_EQUIVALENCE_UNKNOWN',
            detail: 'non-material semantic telemetry',
            material: false
          }
        ]
      },
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    true,
    'non-material unrelated evidence must not prevent stale toolchain recollection'
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: {
        result: 'PASS',
        missingEvidence: []
      },
      runConclusion: 'success',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    false,
    'successful hygiene evidence must never be discarded'
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene: toolchainUnknown,
      runConclusion: 'failure',
      runHeadSha: previousControllerSha,
      currentControllerSha
    }),
    false,
    'failed workflows remain owned by the existing failed-worker recovery path'
  );
});

test('resume controller clears stale UNKNOWN toolchain hygiene before recollection', async () => {
  const body = await readFile(
    'scripts/resume-delivery-v2-controller.mjs',
    'utf8'
  );

  assert.match(
    body,
    /shouldRearmUnknownTechnicalHygiene\(\{[\s\S]*?technicalHygiene: controller\.technicalHygiene[\s\S]*?currentControllerSha/
  );

  assert.match(
    body,
    /nextAction: 'dispatch-technical-hygiene'[\s\S]*?hygieneRunId: null,[\s\S]*?technicalHygiene: null,[\s\S]*?reason: 'control-plane-changed-after-unknown-technical-hygiene'/
  );
});

test('resume entry preserves technical hygiene recovery state before release evaluation', () => {
  for (const nextAction of [
    'dispatch-technical-hygiene',
    'observe-technical-hygiene',
    'technical-hygiene-worker-failed'
  ]) {
    assert.equal(
      resumeEntryNextAction({
        stateStatus: 'ready-for-human-merge',
        controllerNextAction: nextAction
      }),
      nextAction
    );
  }

  assert.equal(
    resumeEntryNextAction({
      stateStatus: 'ready-for-human-merge',
      controllerNextAction: 'observe-ci'
    }),
    'ready-for-human-merge'
  );

  assert.equal(
    resumeEntryNextAction({
      stateStatus: 'audit-pending',
      controllerNextAction: ''
    }),
    'audit-pending'
  );
});

test('resume controller clears stale hygiene run before redispatch', async () => {
  const body = await readFile(
    'scripts/resume-delivery-v2-controller.mjs',
    'utf8'
  );

  assert.match(
    body,
    /shouldRearmFailedTechnicalHygiene\(\{[\s\S]*?hygieneRun = null;/
  );

  assert.match(
    body,
    /reason: 'control-plane-changed-after-technical-hygiene-failure'/
  );

  assert.match(
    body,
    /nextAction: 'dispatch-technical-hygiene'[\s\S]*?hygieneRunId: null/
  );

  assert.match(
    body,
    /if \(!hygieneRun\) \{[\s\S]*?dispatchWorker\(\{/
  );
});

test('current hygiene infrastructure vocabulary can rearm after a control-plane change', () => {
  const technicalHygiene = {
    result: 'UNKNOWN',
    missingEvidence: [
      {
        code: 'SAFE_OUTPUT_TOOL_UNAVAILABLE',
        detail: 'worker could not locate safeoutputs noop',
        material: true
      },
      {
        code: 'TEST_EXECUTION_UNAVAILABLE',
        detail: 'worker could not execute the focused test command',
        material: true
      }
    ]
  };

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene,
      runConclusion: 'success',
      runHeadSha: 'a'.repeat(40),
      currentControllerSha: 'b'.repeat(40)
    }),
    true
  );

  assert.equal(
    shouldRearmUnknownTechnicalHygiene({
      technicalHygiene,
      runConclusion: 'success',
      runHeadSha: 'b'.repeat(40),
      currentControllerSha: 'b'.repeat(40)
    }),
    false,
    'same-SHA retries must remain blocked'
  );
});
