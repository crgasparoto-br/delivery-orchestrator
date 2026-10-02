import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  buildControllerCheckpoint,
  checkpointElapsedMs,
  decideControllerContinuation,
  originIssueStatus
} from '../src/v2/controller-continuity.mjs';

const SOLVERFIN_691 = Object.freeze({
  repository: 'crgasparoto-br/SolverFin',
  issueNumber: 691,
  pullRequestNumber: 701,
  branch: 'delivery-v2/691',
  materialHeadSha: '20ddcfea6f3314b97dee239ae387a71f5b7eb03a',
  failedCiRunId: 37037276068
});

test('a wait longer than 60s remains resumable from the persisted checkpoint', () => {
  const checkpoint = buildControllerCheckpoint({
    ...SOLVERFIN_691,
    nextPhase: 'observe-ci',
    evidenceRefs: [`github:actions:${SOLVERFIN_691.failedCiRunId}`],
    recordedAtMs: 1_000
  });

  assert.equal(checkpointElapsedMs(checkpoint, 62_500), 61_500);
  assert.equal(checkpoint.owner, 'ci-observation');
  assert.equal(checkpoint.nextPhase, 'observe-ci');
  assert.equal(checkpoint.lastEvidenceRef, `github:actions:${SOLVERFIN_691.failedCiRunId}`);

  const decision = decideControllerContinuation({
    controllerOutcome: 'failure',
    stateStatus: 'ci-pending',
    nextAction: 'observe-ci',
    checkpoint,
    previousContinuationCount: 0
  });

  assert.equal(decision.action, 'dispatch-resume');
  assert.equal(decision.nextContinuationCount, 1);
});

test('SolverFin #691 / PR #701 CI failure resumes into remediation instead of terminating', () => {
  const checkpoint = buildControllerCheckpoint({
    ...SOLVERFIN_691,
    nextPhase: 'dispatch-ci-remediation',
    evidenceRefs: [
      `https://github.com/crgasparoto-br/SolverFin/actions/runs/${SOLVERFIN_691.failedCiRunId}`
    ],
    recordedAtMs: 10_000
  });

  const decision = decideControllerContinuation({
    controllerOutcome: 'failure',
    stateStatus: 'ci-failed-remediable',
    nextAction: 'dispatch-ci-remediation',
    checkpoint,
    previousContinuationCount: 1
  });

  assert.equal(decision.action, 'dispatch-resume');
  assert.equal(decision.nextPhase, 'dispatch-ci-remediation');
  assert.match(decision.fingerprint, /SolverFin:691:701:20ddcfea/);
});

test('continuation budget prevents an infinite redispatch loop', () => {
  const checkpoint = buildControllerCheckpoint({ ...SOLVERFIN_691, nextPhase: 'observe-ci' });
  const decision = decideControllerContinuation({
    controllerOutcome: 'failure',
    stateStatus: 'ci-pending',
    nextAction: 'observe-ci',
    checkpoint,
    previousContinuationCount: 3,
    maxContinuations: 3
  });
  assert.deepEqual(decision, { action: 'blocked', reason: 'continuation-budget-exhausted' });
});

test('origin issue remains non-terminal when a continuation was scheduled', () => {
  const status = originIssueStatus({
    result: { status: 'ci-pending', pullRequestNumber: 701, materialHeadSha: SOLVERFIN_691.materialHeadSha },
    controllerOutcome: 'failure',
    continuationScheduled: true,
    runUrl: 'https://github.com/crgasparoto-br/delivery-orchestrator/actions/runs/1'
  });
  assert.equal(status.terminal, false);
  assert.equal(status.state, 'retomada-agendada');
});

test('mismatched persisted phase fails closed instead of dispatching duplicate work', () => {
  const checkpoint = buildControllerCheckpoint({ ...SOLVERFIN_691, nextPhase: 'observe-ci' });
  const decision = decideControllerContinuation({
    controllerOutcome: 'failure',
    stateStatus: 'ci-failed-remediable',
    nextAction: 'dispatch-ci-remediation',
    checkpoint,
    previousContinuationCount: 0
  });
  assert.deepEqual(decision, { action: 'blocked', reason: 'checkpoint-phase-mismatch' });
});

test('both controller entrypoints persist the recoverable wait checkpoint', async () => {
  const [initial, resume] = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);
  for (const body of [initial, resume]) {
    assert.match(body, /buildControllerCheckpoint/);
    assert.match(body, /waitCheckpoint/);
    assert.match(body, /nextPhase/);
    assert.match(body, /materialHeadSha/);
  }
});

test('dispatch workflow schedules bounded continuation and always updates the origin issue', async () => {
  const workflow = await readFile('.github/workflows/delivery-v2-dispatch.yml', 'utf8');
  assert.match(workflow, /Schedule resilient continuation/);
  assert.match(workflow, /continue-delivery-v2-after-interruption\.mjs/);
  assert.match(workflow, /steps\.controller\.outcome == 'failure'/);
  assert.match(workflow, /Update origin issue delivery status/);
  assert.match(workflow, /publish-delivery-v2-issue-status\.mjs/);
  assert.match(workflow, /DELIVERY_V2_CONTINUATION_SCHEDULED/);
});


test('continuation reservation is persisted before the redispatch outbound', async () => {
  const body = await readFile('scripts/continue-delivery-v2-after-interruption.mjs', 'utf8');
  const reservation = body.indexOf('reservedStateBody');
  const statePatch = body.indexOf('/issues/comments/', reservation);
  const dispatch = body.indexOf('/actions/workflows/delivery-v2-dispatch.yml/dispatches', reservation);
  assert.ok(reservation >= 0, 'continuation must create a durable reservation');
  assert.ok(statePatch > reservation, 'continuation reservation must be persisted');
  assert.ok(dispatch > statePatch, 'outbound redispatch must happen only after the reservation is durable');
});

test('origin issue status is published only after delivery evidence upload', async () => {
  const workflow = await readFile('.github/workflows/delivery-v2-dispatch.yml', 'utf8');
  const evidence = workflow.indexOf('Upload delivery evidence');
  const issueStatus = workflow.indexOf('Update origin issue delivery status');
  const summary = workflow.indexOf('Publish controller summary');
  assert.ok(evidence >= 0);
  assert.ok(issueStatus > evidence, 'issue status must not precede final evidence publication');
  assert.ok(summary > issueStatus, 'controller summary remains the final operational step');
});
