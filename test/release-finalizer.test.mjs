import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeIndependentRelease } from '../src/release-finalizer.mjs';

const baseState = {
  status: 'COMPLETE',
  history: [],
  bound_pull_request: 42,
  bound_head_ref: 'feature/issue-7',
  bound_head_sha: 'old-head',
  material_head_sha: 'material-1',
  handoff_head_sha: 'handoff-1',
  last_audit: { status: 'approved', validity: 'independent', release_gate_satisfied: true }
};
const config = {
  repository: 'owner/repo',
  issueNumber: 7,
  writeToken: 'write-token',
  readToken: 'read-token'
};

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}

function exactPr() {
  return {
    number: 42,
    state: 'open',
    title: 'fix #7',
    body: 'Closes #7',
    head: { ref: 'feature/issue-7', sha: 'handoff-1' }
  };
}

test('keeps COMPLETE only after exact-head release signal is published', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/pulls?state=open&per_page=100')) return response([exactPr()]);
    if (url.endsWith('/pulls/42')) return response(exactPr());
    if (url.endsWith('/issues/42/comments?per_page=100')) return response([]);
    if (url.endsWith('/issues/42/comments') && options.method === 'POST') {
      return response({ id: 9, html_url: 'https://example.test/comment/9' }, 201);
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await finalizeIndependentRelease({ state: baseState, config, fetchImpl });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.release_signal.published, true);
  assert.equal(result.bound_head_sha, 'handoff-1');
});

test('invalidates COMPLETE when the PR head changed after audit', async () => {
  const moved = { ...exactPr(), head: { ref: 'feature/issue-7', sha: 'new-head' } };
  const fetchImpl = async (url) => {
    if (url.endsWith('/pulls?state=open&per_page=100')) return response([moved]);
    if (url.endsWith('/pulls/42')) return response(moved);
    throw new Error(`unexpected request ${url}`);
  };

  const result = await finalizeIndependentRelease({ state: baseState, config, fetchImpl });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.release_signal.reason, 'head-mismatch');
  assert.equal(result.history.at(-1).from, 'COMPLETE');
  assert.equal(result.history.at(-1).to, 'FAILED');
});

test('resolves a newly created PR when the run did not start bound to one', async () => {
  const state = { ...baseState, bound_pull_request: null, bound_head_ref: null, bound_head_sha: null };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/pulls?state=open&per_page=100')) return response([exactPr()]);
    if (url.endsWith('/pulls/42')) return response(exactPr());
    if (url.endsWith('/issues/42/comments?per_page=100')) return response([]);
    if (url.endsWith('/issues/42/comments') && options.method === 'POST') {
      return response({ id: 10, html_url: 'https://example.test/comment/10' }, 201);
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await finalizeIndependentRelease({ state, config, fetchImpl });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.bound_pull_request, 42);
  assert.equal(result.release_signal.published, true);
});

test('fails closed when release PR resolution is ambiguous', async () => {
  const pr1 = exactPr();
  const pr2 = { ...exactPr(), number: 43, head: { ref: 'other', sha: 'handoff-1' } };
  const fetchImpl = async (url) => {
    if (url.endsWith('/pulls?state=open&per_page=100')) return response([pr1, pr2]);
    throw new Error(`unexpected request ${url}`);
  };

  const result = await finalizeIndependentRelease({
    state: { ...baseState, bound_pull_request: null },
    config,
    fetchImpl
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.release_signal.reason, 'release-pr-ambiguous');
});
