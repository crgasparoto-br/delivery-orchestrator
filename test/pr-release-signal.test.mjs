import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_SIGNAL_MARKER,
  isIndependentReleaseApproved,
  publishIndependentAuditReleaseSignal
} from '../src/pr-release-signal.mjs';

const approvedAudit = {
  status: 'approved',
  validity: 'independent',
  release_gate_satisfied: true
};

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}

test('only an independent approved release gate is eligible', () => {
  assert.equal(isIndependentReleaseApproved(approvedAudit), true);
  assert.equal(isIndependentReleaseApproved({ ...approvedAudit, validity: 'controller-adversarial' }), false);
  assert.equal(isIndependentReleaseApproved({ ...approvedAudit, validity: 'pre-audit' }), false);
  assert.equal(isIndependentReleaseApproved({ ...approvedAudit, release_gate_satisfied: false }), false);
  assert.equal(isIndependentReleaseApproved({ ...approvedAudit, status: 'rejected' }), false);
});

test('publishes exactly one release comment for the exact current PR head', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/pulls/42')) return response({ state: 'open', head: { sha: 'handoff-123' } });
    if (url.endsWith('/issues/42/comments?per_page=100')) return response([]);
    if (url.endsWith('/issues/42/comments') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.match(payload.body, /PR LIBERADA PARA MERGE/);
      assert.match(payload.body, /ready-for-human-merge/);
      assert.match(payload.body, /handoff-123/);
      return response({ id: 99, html_url: 'https://example.test/comment/99', body: payload.body }, 201);
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await publishIndependentAuditReleaseSignal({
    repository: 'owner/repo',
    pullRequestNumber: 42,
    expectedHeadSha: 'handoff-123',
    materialHeadSha: 'material-456',
    audit: approvedAudit,
    token: 'write-token',
    fetchImpl
  });

  assert.equal(result.published, true);
  assert.equal(result.action, 'created');
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
});

test('updates the orchestrator release comment instead of duplicating it', async () => {
  let posted = false;
  let patched = false;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/pulls/42')) return response({ state: 'open', head: { sha: 'handoff-123' } });
    if (url.endsWith('/issues/42/comments?per_page=100')) {
      return response([{ id: 77, body: `${RELEASE_SIGNAL_MARKER}\nold signal` }]);
    }
    if (url.endsWith('/issues/comments/77') && options.method === 'PATCH') {
      patched = true;
      return response({ id: 77, html_url: 'https://example.test/comment/77' });
    }
    if (options.method === 'POST') posted = true;
    throw new Error(`unexpected request ${url}`);
  };

  const result = await publishIndependentAuditReleaseSignal({
    repository: 'owner/repo',
    pullRequestNumber: 42,
    expectedHeadSha: 'handoff-123',
    materialHeadSha: 'material-456',
    audit: approvedAudit,
    token: 'write-token',
    fetchImpl
  });

  assert.equal(result.published, true);
  assert.equal(result.action, 'updated');
  assert.equal(patched, true);
  assert.equal(posted, false);
});

test('refuses to publish when the PR head moved after the audit', async () => {
  let writes = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' || options.method === 'PATCH') writes += 1;
    if (url.endsWith('/pulls/42')) return response({ state: 'open', head: { sha: 'newer-head' } });
    throw new Error(`unexpected request ${url}`);
  };

  const result = await publishIndependentAuditReleaseSignal({
    repository: 'owner/repo',
    pullRequestNumber: 42,
    expectedHeadSha: 'audited-head',
    materialHeadSha: 'material-456',
    audit: approvedAudit,
    token: 'write-token',
    fetchImpl
  });

  assert.equal(result.published, false);
  assert.equal(result.reason, 'head-mismatch');
  assert.equal(result.observed_head_sha, 'newer-head');
  assert.equal(writes, 0);
});

test('does not inspect the PR for a non-releasable audit', async () => {
  let called = false;
  const result = await publishIndependentAuditReleaseSignal({
    repository: 'owner/repo',
    pullRequestNumber: 42,
    expectedHeadSha: 'head',
    materialHeadSha: 'material',
    audit: { ...approvedAudit, validity: 'controller-adversarial' },
    token: 'write-token',
    fetchImpl: async () => { called = true; throw new Error('must not be called'); }
  });
  assert.equal(result.published, false);
  assert.equal(result.reason, 'audit-not-releasable');
  assert.equal(called, false);
});
