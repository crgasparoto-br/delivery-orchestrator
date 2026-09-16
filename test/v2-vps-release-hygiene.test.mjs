import test from 'node:test';
import assert from 'node:assert/strict';
import { decideUpdate, isSupportedNode, runReleaseCycle, sanitize } from '../src/v2/vps-release-runtime.mjs';

function fakeOps(overrides = {}) {
  const calls = [];
  let active = Object.prototype.hasOwnProperty.call(overrides, 'current') ? overrides.current : 'a'.repeat(40);
  const candidate = overrides.candidate ?? 'b'.repeat(40);
  const ops = {
    calls,
    acquireLock() { calls.push('lock'); if (overrides.lockError) throw new Error('lock-held'); },
    releaseLock() { calls.push('unlock'); },
    sourceClean() { calls.push('sourceClean'); return overrides.sourceClean ?? true; },
    currentSha() { calls.push('currentSha'); return active; },
    currentClean() { calls.push('currentClean'); return overrides.currentClean ?? true; },
    fetchCandidateSha() { calls.push('fetch'); if (overrides.fetchError) throw new Error('network unavailable'); return candidate; },
    isAncestor() { calls.push('ancestor'); return overrides.ancestor ?? true; },
    prepareCandidate() { calls.push('prepare'); if (overrides.prepareError) throw new Error('validation failed'); return overrides.gates ?? { node: true, npm_ci: true, npm_test: true, verify_v2: true, exact_sha: true, clean: true }; },
    promote(sha) { calls.push('promote'); active = overrides.promoteWrongSha ? 'c'.repeat(40) : sha; },
    activeRelease() { return active ? `/releases/${active}` : null; },
    runHygiene() { calls.push('hygiene'); return overrides.hygieneStatus ?? 0; },
    pruneReleases() { calls.push('prune'); },
    writeAudit(audit) { calls.push('audit'); ops.audit = structuredClone(audit); },
  };
  return ops;
}

test('decision blocks dirty source and active release', () => {
  assert.equal(decideUpdate({ currentSha: 'a', candidateSha: 'b', sourceClean: false, currentClean: true, ancestor: true }).reason, 'source-working-tree-dirty');
  assert.equal(decideUpdate({ currentSha: 'a', candidateSha: 'b', sourceClean: true, currentClean: false, ancestor: true }).reason, 'active-release-dirty');
});

test('new valid candidate is validated, promoted, then hygiene runs on it', async () => {
  const ops = fakeOps();
  const result = await runReleaseCycle({ ops });
  assert.equal(result.decision, 'promoted');
  assert.equal(result.executed_sha, 'b'.repeat(40));
  assert.deepEqual(ops.calls.filter((x) => ['fetch','ancestor','prepare','promote','hygiene','prune'].includes(x)), ['fetch','ancestor','prepare','promote','hygiene','prune']);
});

test('already-current skips validation and still runs hygiene', async () => {
  const sha = 'a'.repeat(40);
  const ops = fakeOps({ current: sha, candidate: sha });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.decision, 'already-current');
  assert.equal(ops.calls.includes('prepare'), false);
  assert.equal(ops.calls.includes('hygiene'), true);
});

test('candidate validation failure preserves active release and skips hygiene', async () => {
  const ops = fakeOps({ prepareError: true });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.decision, 'failed');
  assert.equal(result.current_sha, 'a'.repeat(40));
  assert.equal(ops.calls.includes('promote'), false);
  assert.equal(ops.calls.includes('hygiene'), false);
});

test('verify gate false prevents promotion and hygiene', async () => {
  const ops = fakeOps({ gates: { node: true, npm_ci: true, npm_test: true, verify_v2: false, exact_sha: true, clean: true } });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.reason, 'candidate-validation-failed');
  assert.equal(ops.calls.includes('promote'), false);
  assert.equal(ops.calls.includes('hygiene'), false);
});

test('dirty source blocks fetch and hygiene', async () => {
  const ops = fakeOps({ sourceClean: false });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.reason, 'source-working-tree-dirty');
  assert.equal(ops.calls.includes('fetch'), false);
  assert.equal(ops.calls.includes('hygiene'), false);
});

test('divergence blocks without mutation', async () => {
  const ops = fakeOps({ ancestor: false });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.reason, 'non-fast-forward-divergence');
  assert.equal(ops.calls.includes('prepare'), false);
  assert.equal(ops.calls.includes('promote'), false);
  assert.equal(ops.calls.includes('hygiene'), false);
});

test('fetch failure preserves current release and skips hygiene', async () => {
  const ops = fakeOps({ fetchError: true });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.reason, 'fetch-failed');
  assert.equal(ops.calls.includes('promote'), false);
  assert.equal(ops.calls.includes('hygiene'), false);
});

test('promotion is revalidated before hygiene', async () => {
  const ops = fakeOps({ promoteWrongSha: true });
  const result = await runReleaseCycle({ ops });
  assert.equal(result.reason, 'promotion-verification-failed');
  assert.equal(ops.calls.includes('hygiene'), false);
});

test('concurrent lock failure performs no mutation', async () => {
  const ops = fakeOps({ lockError: true });
  const result = await runReleaseCycle({ ops });
  assert.match(result.error, /lock-held/);
  assert.equal(ops.calls.includes('fetch'), false);
  assert.equal(ops.calls.includes('promote'), false);
});

test('bootstrap allows missing current release but normal execution blocks it', async () => {
  const normalOps = fakeOps({ current: null });
  const normal = await runReleaseCycle({ ops: normalOps });
  assert.equal(normal.reason, 'current-release-missing');
  const bootstrapOps = fakeOps({ current: null });
  const bootstrap = await runReleaseCycle({ ops: bootstrapOps, bootstrap: true, runHygiene: false });
  assert.equal(bootstrap.decision, 'promoted');
  assert.equal(bootstrap.executed_sha, null);
});

test('sanitization removes token and authorization value', () => {
  assert.equal(sanitize('token secret-token authorization: bearer-value', ['secret-token']), 'token [REDACTED] authorization: [REDACTED]');
});

test('Node gate requires major 22 or newer', () => {
  assert.equal(isSupportedNode('22.0.0'), true);
  assert.equal(isSupportedNode('24.1.0'), true);
  assert.equal(isSupportedNode('20.19.0'), false);
});
