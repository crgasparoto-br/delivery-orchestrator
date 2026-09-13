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
const pr = {
  number: 2, title: 'PR', body: 'body', user: { login: 'user' }, merge_commit_sha: sha,
  base: { ref: 'main', sha, repo: { full_name: 'owner/repo', private: true, owner: { login: 'owner' } } },
  head: { ref: 'feature', sha, repo: { full_name: 'owner/repo', private: true, owner: { login: 'owner' } } },
  hugeUnneededField: 'x'.repeat(10000)
};

test('compact PR retains semantic identity without full GitHub API objects', () => {
  const compact = compactAuditPullRequest(pr, 'standard');
  assert.deepEqual(compact.base, { ref: 'main', sha, repo: { fullName: 'owner/repo' } });
  assert.deepEqual(compact.head, { ref: 'feature', sha, repo: { fullName: 'owner/repo' } });
  assert.equal('hugeUnneededField' in compact, false);
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
