import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DELIVERY_V2_RELEASE_STATUS_NAME,
  evaluateReleaseGate
} from '../src/v2/release-gate.mjs';

async function loadEvidence() {
  return JSON.parse(await readFile(new URL('../docs/delivery-v2/evidence/dv2-010-exact-head-release.json', import.meta.url), 'utf8'));
}

function sha256Source(source) {
  return createHash('sha256').update(source).digest('hex');
}

function gitBlobSha(source) {
  const body = Buffer.from(source, 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

async function liveInput() {
  const evidence = await loadEvidence();
  const classifierSource = await readFile(new URL('../src/v2/risk-profile.mjs', import.meta.url), 'utf8');
  const fingerprint = sha256Source(classifierSource);

  assert.equal(gitBlobSha(classifierSource), evidence.classifier.gitBlobSha);

  return {
    evidence,
    input: {
      schemaVersion: 1,
      repository: evidence.repository,
      pullRequestNumber: evidence.pullRequestNumber,
      materialHeadSha: evidence.materialHeadSha,
      currentRemoteHeadSha: evidence.currentRemoteHeadShaAtFreeze,
      evidenceCollection: evidence.evidenceCollection,
      classifier: {
        subjectSha: evidence.classifier.subjectSha,
        profile: evidence.classifier.profile,
        version: evidence.classifier.version,
        fingerprint,
        expectedFingerprint: fingerprint,
        evidenceRef: evidence.classifier.evidenceRef
      },
      mergePreview: evidence.mergePreview,
      checks: evidence.checks,
      audit: {
        candidateSha: evidence.audit.candidateSha,
        decision: evidence.audit.decision,
        mode: evidence.audit.mode,
        requestFingerprint: evidence.audit.requestFingerprint,
        evidenceRef: evidence.audit.evidenceRef
      },
      unresolvedFindings: evidence.unresolvedFindings,
      blockers: evidence.blockers
    }
  };
}

function setMutation(input, mutation, value) {
  const copy = JSON.parse(JSON.stringify(input));
  if (mutation === 'currentRemoteHeadSha') copy.currentRemoteHeadSha = value;
  else if (mutation === 'checks[0].subjectSha') copy.checks[0].subjectSha = value;
  else if (mutation === 'audit.candidateSha') copy.audit.candidateSha = value;
  else if (mutation === 'classifier.fingerprint') copy.classifier.fingerprint = value;
  else throw new Error(`unsupported mutation: ${mutation}`);
  return copy;
}

test('DV2-010 derives ready-for-human-merge from the real final PR #48 exact-head evidence', async () => {
  const { evidence, input } = await liveInput();
  const result = evaluateReleaseGate(input);

  assert.equal(result.repository, evidence.repository);
  assert.equal(result.pullRequestNumber, evidence.pullRequestNumber);
  assert.equal(result.candidateSha, evidence.materialHeadSha);
  assert.equal(result.currentRemoteHeadSha, evidence.materialHeadSha);
  assert.equal(result.readiness, evidence.expectedRelease.readiness);
  assert.equal(result.state, evidence.expectedRelease.state);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.requiredStatus, {
    name: DELIVERY_V2_RELEASE_STATUS_NAME,
    state: 'success'
  });
  assert.deepEqual(result.mergePolicy, evidence.expectedRelease.mergePolicy);
  assert.equal(result.controls.storesEvidenceReferencesOnly, true);
  assert.equal(result.controls.createsResultOnlyCommit, false);
  assert.deepEqual(result.evidenceRefs.checks, ['github-actions:34690592843']);
  assert.equal(result.evidenceRefs.audit, 'github:delivery-orchestrator#48:comment-5645558801');
  assert.equal(evidence.observedMerge.mergeCommitSha, '134fea2c8dffd4db5678935e5ab2386585f0169c');
});

test('DV2-010 invalidates the real release candidate when any exact-head binding drifts', async () => {
  const { evidence, input } = await liveInput();

  for (const scenario of evidence.invalidationScenarios) {
    const result = evaluateReleaseGate(setMutation(input, scenario.mutation, scenario.value));
    assert.equal(result.readiness, false, scenario.id);
    assert.equal(result.state, scenario.expectedState, scenario.id);
    assert.deepEqual(result.reasons, [scenario.expectedReason], scenario.id);
    assert.notEqual(result.requiredStatus.state, 'success', scenario.id);
  }
});

test('DV2-010 live evidence binds the exact CI and independent-audit runs used for the observed merge', async () => {
  const evidence = await loadEvidence();

  assert.equal(evidence.checks.length, 1);
  assert.equal(evidence.checks[0].subjectSha, evidence.materialHeadSha);
  assert.equal(evidence.checks[0].workflowRunId, 34690592843);
  assert.equal(evidence.checks[0].conclusion, 'success');
  assert.equal(evidence.audit.candidateSha, evidence.materialHeadSha);
  assert.equal(evidence.audit.workflowRunId, 34690625580);
  assert.equal(evidence.audit.decision, 'approved');
  assert.equal(evidence.audit.mode, 'independent');
  assert.equal(evidence.audit.requestFingerprint, '363824d1c8391469fb0003351b58da757907d298bb6b2f2617e83cd51e8ac6a8');
  assert.deepEqual(evidence.unresolvedFindings, []);
  assert.deepEqual(evidence.blockers, []);
});
