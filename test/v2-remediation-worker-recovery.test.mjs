import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recoverPersistedRemediationContext,
  resumeEntryNextAction,
  shouldRearmFailedRemediationWorker
} from '../scripts/resume-delivery-v2-controller.mjs';

const SHA_A =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MATERIAL =
  'cccccccccccccccccccccccccccccccccccccccc';

test('preserves remediation failure action on resume', () => {
  assert.equal(
    resumeEntryNextAction({
      stateStatus: 'implementing',
      controllerNextAction: 'remediation-worker-failed'
    }),
    'remediation-worker-failed'
  );

  assert.equal(
    resumeEntryNextAction({
      stateStatus: 'implementing',
      controllerNextAction: 'observe-remediation-recovery'
    }),
    'observe-remediation-recovery'
  );
});

test('rearms a failed remediation after control-plane SHA changes', () => {
  assert.equal(
    shouldRearmFailedRemediationWorker({
      stateStatus: 'implementing',
      runConclusion: 'failure',
      runHeadSha: SHA_A,
      currentControllerSha: SHA_B,
      materialHeadSha: MATERIAL,
      currentHeadSha: MATERIAL,
      currentPrTitle: '[delivery-v2] fix: example'
    }),
    true
  );
});

test('does not loop recovery on the same controller SHA epoch', () => {
  assert.equal(
    shouldRearmFailedRemediationWorker({
      stateStatus: 'implementing',
      runConclusion: 'failure',
      runHeadSha: SHA_A,
      currentControllerSha: SHA_B,
      previousRecoveryControllerSha: SHA_B,
      materialHeadSha: MATERIAL,
      currentHeadSha: MATERIAL,
      currentPrTitle: '[delivery-v2] fix: example'
    }),
    false
  );
});

test('rearms when PR safe-output title precondition was fixed', () => {
  assert.equal(
    shouldRearmFailedRemediationWorker({
      stateStatus: 'implementing',
      runConclusion: 'failure',
      runHeadSha: SHA_A,
      currentControllerSha: SHA_A,
      materialHeadSha: MATERIAL,
      currentHeadSha: MATERIAL,
      previousPrTitle:
        'fix(whatsapp): correlacionar rotulo',
      currentPrTitle:
        '[delivery-v2] fix(whatsapp): correlacionar rotulo'
    }),
    true
  );
});

test('does not rearm for unchanged PR metadata on same controller', () => {
  assert.equal(
    shouldRearmFailedRemediationWorker({
      stateStatus: 'implementing',
      runConclusion: 'failure',
      runHeadSha: SHA_A,
      currentControllerSha: SHA_A,
      materialHeadSha: MATERIAL,
      currentHeadSha: MATERIAL,
      previousPrTitle:
        '[delivery-v2] fix: example',
      currentPrTitle:
        '[delivery-v2] fix: example'
    }),
    false
  );
});

test('does not recover if target material SHA drifted', () => {
  assert.equal(
    shouldRearmFailedRemediationWorker({
      stateStatus: 'implementing',
      runConclusion: 'failure',
      runHeadSha: SHA_A,
      currentControllerSha: SHA_B,
      materialHeadSha: MATERIAL,
      currentHeadSha: SHA_A,
      currentPrTitle: '[delivery-v2] fix: example'
    }),
    false
  );
});

test('reconstructs legacy audit remediation context without resetting budgets', () => {
  const finding = Object.freeze({
    id: 'AUD-1',
    blocksRelease: true
  });

  const context = recoverPersistedRemediationContext({
    state: {
      auditEvidence: {
        decision: 'rejected'
      },
      blockingFindings: [finding]
    },
    controller: {}
  });

  assert.deepEqual(context, {
    source: 'audit-findings',
    findings: [finding],
    newRiskSurfaces: []
  });
});

test('prefers explicitly persisted remediation context', () => {
  const persisted = {
    source: 'ci-failure',
    failure: {
      cause: 'example'
    }
  };

  assert.equal(
    recoverPersistedRemediationContext({
      state: {},
      controller: {
        remediationContext: persisted
      }
    }),
    persisted
  );
});
