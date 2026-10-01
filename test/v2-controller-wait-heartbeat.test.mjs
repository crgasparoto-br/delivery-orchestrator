import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const HEARTBEAT_MS = 20_000;

function shouldEmitHeartbeat({
  now,
  lastHeartbeatAt,
  observedState,
  lastObservedState
}) {
  return (
    observedState !== lastObservedState ||
    now - lastHeartbeatAt >= HEARTBEAT_MS
  );
}

function elapsedSeconds(startedAt, now) {
  return Math.floor((now - startedAt) / 1000);
}

test('wait heartbeat is not emitted again before 20 seconds when state is unchanged', () => {
  assert.equal(
    shouldEmitHeartbeat({
      now: 19_999,
      lastHeartbeatAt: 0,
      observedState: 'run:in_progress:check:queued',
      lastObservedState: 'run:in_progress:check:queued'
    }),
    false
  );
});

test('wait heartbeat is emitted at the 20 second boundary', () => {
  assert.equal(
    shouldEmitHeartbeat({
      now: 20_000,
      lastHeartbeatAt: 0,
      observedState: 'run:in_progress:check:queued',
      lastObservedState: 'run:in_progress:check:queued'
    }),
    true
  );
});

test('status change emits progress immediately before 60 seconds', () => {
  assert.equal(
    shouldEmitHeartbeat({
      now: 5_000,
      lastHeartbeatAt: 0,
      observedState: 'run:completed:success:check:completed:success',
      lastObservedState: 'run:in_progress:-:check:queued:-'
    }),
    true
  );
});

test('missing source run remains an observable wait state', () => {
  assert.equal(
    shouldEmitHeartbeat({
      now: 20_000,
      lastHeartbeatAt: 0,
      observedState: 'source-run-missing',
      lastObservedState: 'source-run-missing'
    }),
    true
  );
});

test('elapsed time is deterministic and expressed in whole seconds', () => {
  assert.equal(elapsedSeconds(1_000, 61_999), 60);
  assert.equal(elapsedSeconds(10_000, 10_000), 0);
  assert.equal(elapsedSeconds(10_000, 130_001), 120);
});

test('initial and resumed controllers share a configurable <=30s heartbeat contract', async () => {
  const [initial, resume] = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);

  for (const [name, body] of [['initial', initial], ['resume', resume]]) {
    assert.match(body, /DELIVERY_V2_HEARTBEAT_MS/,
      `${name}: heartbeat must be configurable`);
    assert.match(body, /DELIVERY_V2_HEARTBEAT_MS \|\| 20000/,
      `${name}: default heartbeat must remain 20 seconds`);
    assert.match(body, /now - lastHeartbeatAt >= HEARTBEAT_MS/,
      `${name}: long waits must use the shared heartbeat interval`);
    assert.doesNotMatch(body, /now - lastHeartbeatAt >= 60_000/,
      `${name}: hard-coded 60 second silence must not return`);
  }
});

test('in-flight worker identity is persisted before resumed controller waits', async () => {
  const resume = await readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8');
  const persistedIdentity = resume.indexOf("cannot safely resume an in-flight implementation without persisted worker identity");
  const wait = resume.indexOf('let run = await waitWorkflowRun(', persistedIdentity);
  assert.ok(persistedIdentity >= 0, 'resume must fail closed without persisted worker identity');
  assert.ok(wait > persistedIdentity, 'resume may wait only after durable worker identity is available');
});

test('initial and resumed controllers expose progress for every material wait family', async () => {
  const [initial, resume] = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);

  for (const [name, body] of [
    ['initial', initial],
    ['resume', resume]
  ]) {
    assert.match(
      body,
      /waiting required check/,
      `${name}: required-check wait must expose progress`
    );

    assert.match(
      body,
      /waiting workflow dispatch correlation/,
      `${name}: workflow dispatch correlation must expose progress`
    );

    assert.match(
      body,
      /waiting workflow run=/,
      `${name}: workflow execution wait must expose progress`
    );

    assert.match(
      body,
      /waiting material head change/,
      `${name}: material-head wait must expose progress`
    );

    assert.match(
      body,
      /elapsed=.*s/,
      `${name}: progress must expose elapsed time`
    );
  }
});

test('required-check progress exposes authoritative workflow, run and check state', async () => {
  const bodies = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);

  for (const body of bodies) {
    assert.match(body, /workflow=.*workflowName/);
    assert.match(body, /sourceRun=.*sourceRun/);
    assert.match(body, /runStatus=.*sourceRun/);
    assert.match(body, /runConclusion=.*sourceRun/);
    assert.match(body, /checkStatus=.*check/);
    assert.match(body, /checkConclusion=.*check/);
  }
});

test('heartbeat implementation preserves bounded wait deadlines', async () => {
  const [initial, resume] = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);

  for (const [name, body] of [
    ['initial', initial],
    ['resume', resume]
  ]) {
    assert.match(
      body,
      /deadline = startedAt \+ MAX_STAGE_MS/,
      `${name}: bounded workflow/check wait must preserve MAX_STAGE_MS`
    );

    assert.match(
      body,
      /deadline = startedAt \+ 2 \* 60 \* 1000/,
      `${name}: dispatch correlation must remain bounded to two minutes`
    );

    assert.match(
      body,
      /deadline = startedAt \+ 15 \* 60 \* 1000/,
      `${name}: material-head wait must remain bounded to fifteen minutes`
    );

    assert.match(
      body,
      /while \(Date\.now\(\) < deadline\)/,
      `${name}: waits must remain deadline bounded`
    );
  }
});

test('terminal and drift paths remain immediate and do not depend on the heartbeat interval', async () => {
  const [initial, resume] = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);

  for (const body of [initial, resume]) {
    assert.match(
      body,
      /sourceRun\?\.status === 'completed'[\s\S]*check\?\.status === 'completed'/
    );

    assert.match(
      body,
      /return \{[\s\S]*kind: 'check'/
    );

    assert.match(
      body,
      /kind: 'head-drift'/
    );

    assert.match(
      body,
      /if \(run\.status === 'completed'\) return run/
    );
  }
});


test('controller wait contract forbids semantically blocking watch primitives', async () => {
  const [initial, resume] = await Promise.all([
    readFile('scripts/run-delivery-v2-controller.mjs', 'utf8'),
    readFile('scripts/resume-delivery-v2-controller.mjs', 'utf8')
  ]);

  for (const [name, body] of [
    ['initial', initial],
    ['resume', resume]
  ]) {
    assert.doesNotMatch(body, /--watch\b/, `${name}: controller must not use --watch waits`);
    assert.doesNotMatch(body, /tail\s+-f\b/, `${name}: controller must not use tail -f waits`);
    assert.doesNotMatch(body, /sleep\([^)]*(?:60_000|60000|[1-9][0-9]{5,})[^)]*\)/,
      `${name}: controller must not introduce prolonged single sleeps`);
  }
});

test('canonical spec separates workflow heartbeat from conversation-stream continuity', async () => {
  const spec = await readFile('docs/delivery-v2/MASTER_SPEC.md', 'utf8');

  assert.match(spec, /workflow\/controller heartbeat/i);
  assert.match(spec, /conversation-stream continuity/i);
  assert.match(spec, /workflow heartbeat is not evidence that the conversation stream is alive/i);
  assert.match(spec, /bounded snapshots/i);
  assert.match(spec, /resume from the persisted next phase/i);
});
