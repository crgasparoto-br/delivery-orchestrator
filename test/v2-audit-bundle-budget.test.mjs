import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditBundleLimitsForRisk,
  auditContextInsufficientFinding,
  compactAuditPullRequest,
  evaluateAuditBundleBudget
} from '../src/v2/audit-bundle-budget.mjs';

const sha = 'a'.repeat(40);
const issue = { number: 1, title: 'Issue', body: 'contract', labels: [{ name: 'bug' }] };
const noisyRepo = {
  full_name: 'owner/repo',
  private: true,
  owner: { login: 'owner', avatar_url: 'https://example.invalid/avatar', followers_url: 'https://api.invalid/followers' },
  archive_url: 'https://api.invalid/archive',
  deployments_url: 'https://api.invalid/deployments',
  hooks_url: 'https://api.invalid/hooks',
  irrelevant: 'x'.repeat(12000)
};
const pr = {
  number: 2,
  title: 'PR',
  body: 'body',
  user: { login: 'user', avatar_url: 'https://example.invalid/avatar', followers_url: 'https://api.invalid/followers' },
  merge_commit_sha: sha,
  base: { ref: 'main', sha, repo: noisyRepo },
  head: { ref: 'feature', sha, repo: noisyRepo },
  hugeUnneededField: 'x'.repeat(10000)
};

test('compact PR retains semantic identity and strips nested GitHub API payloads', () => {
  const compact = compactAuditPullRequest(pr, 'standard');
  assert.deepEqual(compact.base, { ref: 'main', sha, repo: { fullName: 'owner/repo' } });
  assert.deepEqual(compact.head, { ref: 'feature', sha, repo: { fullName: 'owner/repo' } });
  assert.equal(compact.authorLogin, 'user');
  assert.equal('hugeUnneededField' in compact, false);
  assert.equal('owner' in compact.base.repo, false);
  assert.doesNotMatch(JSON.stringify(compact), /followers_url|archive_url|deployments_url|hooks_url|avatar_url/);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 2048);
});

test('oversized issue body fails closed before model invocation', () => {
  const limits = auditBundleLimitsForRisk('standard');
  const budget = evaluateAuditBundleBudget({
    riskProfile: 'standard',
    issue: { ...issue, body: 'x'.repeat(limits.maxIssueBodyBytes + 1) },
    pullRequest: pr,
    files: { contract: 'contract' }
  });
  assert.equal(budget.allowed, false);
  assert.ok(budget.reasons.includes('issue-body-truncated'));
  const finding = auditContextInsufficientFinding({ candidateSha: sha, budget });
  assert.equal(finding.blocksRelease, true);
  assert.equal(finding.id, 'DV2-AUDIT-CONTEXT-INSUFFICIENT');
});

test('oversized pull request body fails closed before model invocation', () => {
  const limits = auditBundleLimitsForRisk('standard');
  const budget = evaluateAuditBundleBudget({
    riskProfile: 'standard',
    issue,
    pullRequest: { ...pr, body: 'x'.repeat(limits.maxPullRequestBodyBytes + 1) },
    files: { contract: 'contract' }
  });
  assert.equal(budget.allowed, false);
  assert.ok(budget.reasons.includes('pull-request-body-truncated'));
});

test('total audit bundle has a risk-specific hard ceiling', () => {
  const limits = auditBundleLimitsForRisk('standard');
  const budget = evaluateAuditBundleBudget({
    riskProfile: 'standard', issue, pullRequest: pr,
    files: { large: 'x'.repeat(limits.maxTotalBytes + 1) }
  });
  assert.equal(budget.allowed, false);
  assert.ok(budget.reasons.includes('bundle-total-byte-limit-exceeded'));
  assert.throws(() => auditBundleLimitsForRisk('fast'), /unsupported audit bundle risk profile/);
});

test('deterministic semantic preflight reasons block model invocation even when byte ceilings fit', () => {
  const budget = evaluateAuditBundleBudget({
    riskProfile: 'critical',
    issue,
    pullRequest: pr,
    files: { contract: 'contract' },
    preflightReasons: ['bounded-diff:required-reservation-byte-limit-exceeded']
  });

  assert.equal(budget.allowed, false);
  assert.deepEqual(budget.reasons, ['bounded-diff:required-reservation-byte-limit-exceeded']);
  const finding = auditContextInsufficientFinding({ candidateSha: sha, budget });
  assert.match(finding.failureMode, /required-reservation-byte-limit-exceeded/);
});
