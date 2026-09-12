import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_V2_RELEASE_STATUS_NAME,
  evaluateReleaseGate
} from '../src/v2/release-gate.mjs';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_M = 'cccccccccccccccccccccccccccccccccccccccc';

function baseInput(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: 'acme/example',
    pullRequestNumber: 42,
    materialHeadSha: SHA_A,
    currentRemoteHeadSha: SHA_A,
    evidenceCollection: {
      materialHeadSha: SHA_A,
      remoteHeadSha: SHA_A,
      evidenceRef: 'github:pr#42@aaaaaaaa'
    },
    classifier: {
      subjectSha: SHA_A,
      profile: 'fast',
      version: 'v2',
      fingerprint: 'fp-1',
      expectedFingerprint: 'fp-1',
      evidenceRef: 'artifact:classifier'
    },
    mergePreview: {
      required: false
    },
    checks: [
      {
        name: 'Validate repository',
        required: true,
        subjectSha: SHA_A,
        status: 'completed',
        conclusion: 'success',
        workflowRunId: 1001,
        evidenceRef: 'github:check/1001'
      }
    ],
    unresolvedFindings: [],
    blockers: [],
    ...overrides
  };
}

test('FAST exact-head evidence reaches ready-for-human-merge without mandatory audit', () => {
  const result = evaluateReleaseGate(baseInput());

  assert.equal(result.readiness, true);
  assert.equal(result.state, 'ready-for-human-merge');
  assert.deepEqual(result.requiredStatus, { name: DELIVERY_V2_RELEASE_STATUS_NAME, state: 'success' });
  assert.equal(result.mergePolicy.decision, 'human-authorized-only');
  assert.equal(result.mergePolicy.automaticMergeAllowed, false);
  assert.equal(result.controls.createsResultOnlyCommit, false);
});

test('CRITICAL requires independent approved audit on the exact candidate', () => {
  const result = evaluateReleaseGate(baseInput({
    classifier: {
      subjectSha: SHA_A,
      profile: 'critical',
      version: 'v2',
      fingerprint: 'critical-fp',
      expectedFingerprint: 'critical-fp',
      evidenceRef: 'artifact:classifier-critical'
    },
    audit: {
      candidateSha: SHA_A,
      decision: 'approved',
      mode: 'independent',
      requestFingerprint: 'audit-request-fp',
      evidenceRef: 'github:audit/123'
    }
  }));

  assert.equal(result.readiness, true);
  assert.equal(result.state, 'ready-for-human-merge');
  assert.equal(result.evidenceRefs.audit, 'github:audit/123');
});

test('remote head drift automatically invalidates readiness and returns to queued', () => {
  const result = evaluateReleaseGate(baseInput({ currentRemoteHeadSha: SHA_B }));

  assert.equal(result.readiness, false);
  assert.equal(result.state, 'queued');
  assert.deepEqual(result.reasons, ['remote-head-drift']);
  assert.equal(result.requiredStatus.state, 'pending');
});

test('evidence collected for a different head cannot certify the current material head', () => {
  const result = evaluateReleaseGate(baseInput({
    evidenceCollection: {
      materialHeadSha: SHA_B,
      remoteHeadSha: SHA_B,
      evidenceRef: 'github:old-collection'
    }
  }));

  assert.equal(result.state, 'queued');
  assert.deepEqual(result.reasons, ['evidence-collected-for-different-head']);
});

test('classifier result must bind both subject SHA and canonical fingerprint', () => {
  const stale = evaluateReleaseGate(baseInput({
    classifier: {
      subjectSha: SHA_B,
      profile: 'fast',
      version: 'v2',
      fingerprint: 'fp-1',
      expectedFingerprint: 'fp-1',
      evidenceRef: 'artifact:classifier'
    }
  }));
  assert.equal(stale.state, 'classified');
  assert.deepEqual(stale.reasons, ['classifier-subject-sha-stale']);

  const driftedFingerprint = evaluateReleaseGate(baseInput({
    classifier: {
      subjectSha: SHA_A,
      profile: 'fast',
      version: 'v2',
      fingerprint: 'fp-old',
      expectedFingerprint: 'fp-new',
      evidenceRef: 'artifact:classifier'
    }
  }));
  assert.equal(driftedFingerprint.state, 'classified');
  assert.deepEqual(driftedFingerprint.reasons, ['classifier-fingerprint-mismatch']);
});

test('required merge-preview must be bound to the material head and green', () => {
  const pending = evaluateReleaseGate(baseInput({
    mergePreview: {
      required: true,
      materialHeadSha: SHA_A,
      previewSha: SHA_M,
      status: 'in_progress',
      conclusion: null,
      evidenceRef: 'github:merge-preview'
    }
  }));
  assert.equal(pending.state, 'ci-pending');
  assert.deepEqual(pending.reasons, ['merge-preview-pending']);

  const failed = evaluateReleaseGate(baseInput({
    mergePreview: {
      required: true,
      materialHeadSha: SHA_A,
      previewSha: SHA_M,
      status: 'completed',
      conclusion: 'failure',
      evidenceRef: 'github:merge-preview'
    }
  }));
  assert.equal(failed.state, 'ci-failed-remediable');
  assert.equal(failed.requiredStatus.state, 'failure');
});

test('all required CI must be terminal green on the exact material head', () => {
  const pending = evaluateReleaseGate(baseInput({
    checks: [
      {
        name: 'Validate repository',
        required: true,
        subjectSha: SHA_A,
        status: 'in_progress',
        conclusion: null,
        workflowRunId: 1001,
        evidenceRef: 'github:check/1001'
      }
    ]
  }));
  assert.equal(pending.state, 'ci-pending');

  const stale = evaluateReleaseGate(baseInput({
    checks: [
      {
        name: 'Validate repository',
        required: true,
        subjectSha: SHA_B,
        status: 'completed',
        conclusion: 'success',
        workflowRunId: 1001,
        evidenceRef: 'github:check/1001'
      }
    ]
  }));
  assert.equal(stale.state, 'ci-pending');
  assert.match(stale.reasons[0], /^required-check-stale:/);

  const failed = evaluateReleaseGate(baseInput({
    checks: [
      {
        name: 'Validate repository',
        required: true,
        subjectSha: SHA_A,
        status: 'completed',
        conclusion: 'failure',
        workflowRunId: 1001,
        evidenceRef: 'github:check/1001'
      }
    ]
  }));
  assert.equal(failed.state, 'ci-failed-remediable');
  assert.match(failed.reasons[0], /^required-check-not-green:/);
});

test('STANDARD audit can be disabled by explicit policy but defaults to focused independent audit', () => {
  const classifier = {
    subjectSha: SHA_A,
    profile: 'standard',
    version: 'v2',
    fingerprint: 'standard-fp',
    expectedFingerprint: 'standard-fp',
    evidenceRef: 'artifact:classifier-standard'
  };

  const defaultPolicy = evaluateReleaseGate(baseInput({ classifier }));
  assert.equal(defaultPolicy.state, 'audit-pending');
  assert.deepEqual(defaultPolicy.reasons, ['required-audit-missing']);

  const disabled = evaluateReleaseGate(baseInput({ classifier, standardAuditRequired: false }));
  assert.equal(disabled.state, 'ready-for-human-merge');
});

test('stale, wrong-mode, or rejected required audit cannot release CRITICAL', () => {
  const classifier = {
    subjectSha: SHA_A,
    profile: 'critical',
    version: 'v2',
    fingerprint: 'critical-fp',
    expectedFingerprint: 'critical-fp',
    evidenceRef: 'artifact:classifier-critical'
  };

  const stale = evaluateReleaseGate(baseInput({
    classifier,
    audit: {
      candidateSha: SHA_B,
      decision: 'approved',
      mode: 'independent',
      requestFingerprint: 'request-1',
      evidenceRef: 'github:audit/1'
    }
  }));
  assert.equal(stale.state, 'audit-pending');
  assert.deepEqual(stale.reasons, ['required-audit-stale']);

  const wrongMode = evaluateReleaseGate(baseInput({
    classifier,
    audit: {
      candidateSha: SHA_A,
      decision: 'approved',
      mode: 'focused-independent',
      requestFingerprint: 'request-2',
      evidenceRef: 'github:audit/2'
    }
  }));
  assert.equal(wrongMode.state, 'audit-pending');
  assert.deepEqual(wrongMode.reasons, ['required-audit-mode-mismatch']);

  const rejected = evaluateReleaseGate(baseInput({
    classifier,
    audit: {
      candidateSha: SHA_A,
      decision: 'rejected',
      mode: 'independent',
      requestFingerprint: 'request-3',
      evidenceRef: 'github:audit/3'
    }
  }));
  assert.equal(rejected.state, 'audit-failed-remediable');
  assert.equal(rejected.requiredStatus.state, 'failure');
});

test('an unresolved blocking finding prevents release even when audit evidence is approved', () => {
  const result = evaluateReleaseGate(baseInput({
    unresolvedFindings: [
      {
        id: 'DV2-AUDIT-001',
        candidateSha: SHA_A,
        status: 'open',
        blocksRelease: true,
        evidenceRef: 'github:finding/1'
      }
    ]
  }));

  assert.equal(result.state, 'audit-failed-remediable');
  assert.deepEqual(result.reasons, ['blocking-finding:DV2-AUDIT-001']);
});

test('budget blockers escalate and external blockers keep release pending without fabricating code remediation', () => {
  const budget = evaluateReleaseGate(baseInput({
    blockers: [{ kind: 'budget', code: 'implementation-budget-exhausted', evidenceRef: 'state:budget' }]
  }));
  assert.equal(budget.state, 'escalated');
  assert.equal(budget.requiredStatus.state, 'failure');

  const external = evaluateReleaseGate(baseInput({
    blockers: [{ kind: 'external', code: 'runner-unavailable', evidenceRef: 'github:runner' }]
  }));
  assert.equal(external.state, 'ci-pending');
  assert.equal(external.requiredStatus.state, 'pending');
});

test('optional FAST audit rejection still blocks release instead of being silently ignored', () => {
  const result = evaluateReleaseGate(baseInput({
    audit: {
      candidateSha: SHA_A,
      decision: 'rejected',
      mode: 'focused-independent',
      requestFingerprint: 'optional-audit-request',
      evidenceRef: 'github:audit/optional'
    }
  }));

  assert.equal(result.state, 'audit-failed-remediable');
  assert.deepEqual(result.reasons, ['optional-audit-rejected']);
});
