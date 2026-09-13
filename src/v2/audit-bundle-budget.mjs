import { createHash } from 'node:crypto';

export const STANDARD_AUDIT_BUNDLE_LIMITS = Object.freeze({
  maxIssueBodyBytes: 24 * 1024,
  maxPullRequestBodyBytes: 16 * 1024,
  maxTotalBytes: 128 * 1024
});

export const CRITICAL_AUDIT_BUNDLE_LIMITS = Object.freeze({
  maxIssueBodyBytes: 48 * 1024,
  maxPullRequestBodyBytes: 32 * 1024,
  maxTotalBytes: 256 * 1024
});

function requiredObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function auditBundleLimitsForRisk(riskProfile) {
  const risk = requiredString(riskProfile, 'riskProfile').toLowerCase();
  if (risk === 'standard') return STANDARD_AUDIT_BUNDLE_LIMITS;
  if (risk === 'critical') return CRITICAL_AUDIT_BUNDLE_LIMITS;
  throw new Error(`unsupported audit bundle risk profile: ${risk}`);
}

export function boundUtf8Text(value, maxBytes) {
  const text = String(value ?? '');
  requiredPositiveInteger(maxBytes, 'maxBytes');
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) {
    return Object.freeze({
      text,
      originalBytes,
      includedBytes: originalBytes,
      omittedBytes: 0,
      truncated: false,
      sha256: createHash('sha256').update(text).digest('hex')
    });
  }
  let included = '';
  let includedBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (includedBytes + charBytes > maxBytes) break;
    included += char;
    includedBytes += charBytes;
  }
  return Object.freeze({
    text: included,
    originalBytes,
    includedBytes,
    omittedBytes: originalBytes - includedBytes,
    truncated: true,
    sha256: createHash('sha256').update(text).digest('hex')
  });
}

function compactRepo(repo) {
  if (!repo) return null;
  const fullName = String(repo.full_name ?? '').trim();
  return fullName ? Object.freeze({ fullName }) : null;
}

export function compactAuditIssue(issue, riskProfile) {
  const source = requiredObject(issue, 'issue');
  const limits = auditBundleLimitsForRisk(riskProfile);
  const body = boundUtf8Text(source.body ?? '', limits.maxIssueBodyBytes);
  return Object.freeze({
    number: requiredPositiveInteger(source.number, 'issue.number'),
    title: String(source.title ?? ''),
    body: body.text,
    bodyContext: Object.freeze({
      originalBytes: body.originalBytes,
      includedBytes: body.includedBytes,
      omittedBytes: body.omittedBytes,
      truncated: body.truncated,
      sha256: body.sha256
    }),
    labels: Object.freeze((source.labels ?? []).map((item) => String(item?.name ?? item ?? '')).filter(Boolean))
  });
}

export function compactAuditPullRequest(pullRequest, riskProfile) {
  const source = requiredObject(pullRequest, 'pullRequest');
  const limits = auditBundleLimitsForRisk(riskProfile);
  const body = boundUtf8Text(source.body ?? '', limits.maxPullRequestBodyBytes);
  return Object.freeze({
    number: requiredPositiveInteger(source.number, 'pullRequest.number'),
    title: String(source.title ?? ''),
    body: body.text,
    bodyContext: Object.freeze({
      originalBytes: body.originalBytes,
      includedBytes: body.includedBytes,
      omittedBytes: body.omittedBytes,
      truncated: body.truncated,
      sha256: body.sha256
    }),
    base: Object.freeze({
      ref: requiredString(source.base?.ref, 'pullRequest.base.ref'),
      sha: requiredString(source.base?.sha, 'pullRequest.base.sha').toLowerCase(),
      repo: compactRepo(source.base?.repo)
    }),
    head: Object.freeze({
      ref: requiredString(source.head?.ref, 'pullRequest.head.ref'),
      sha: requiredString(source.head?.sha, 'pullRequest.head.sha').toLowerCase(),
      repo: compactRepo(source.head?.repo)
    }),
    authorLogin: String(source.user?.login ?? ''),
    mergeCommitSha: source.merge_commit_sha ? String(source.merge_commit_sha).toLowerCase() : null
  });
}

export function evaluateAuditBundleBudget({ riskProfile, issue, pullRequest, files } = {}) {
  const limits = auditBundleLimitsForRisk(riskProfile);
  const issueProjection = compactAuditIssue(issue, riskProfile);
  const pullRequestProjection = compactAuditPullRequest(pullRequest, riskProfile);
  const fileMap = requiredObject(files, 'files');
  const totalBytes = Object.values(fileMap).reduce((sum, value) => sum + Buffer.byteLength(String(value ?? ''), 'utf8'), 0)
    + Buffer.byteLength(JSON.stringify(issueProjection), 'utf8')
    + Buffer.byteLength(JSON.stringify(pullRequestProjection), 'utf8');
  const reasons = [];
  if (issueProjection.bodyContext.truncated) reasons.push('issue-body-truncated');
  if (pullRequestProjection.bodyContext.truncated) reasons.push('pull-request-body-truncated');
  if (totalBytes > limits.maxTotalBytes) reasons.push('bundle-total-byte-limit-exceeded');
  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    limits,
    totalBytes,
    issue: issueProjection,
    pullRequest: pullRequestProjection
  });
}

export function auditContextInsufficientFinding({ candidateSha, budget } = {}) {
  const sha = requiredString(candidateSha, 'candidateSha').toLowerCase();
  const value = requiredObject(budget, 'budget');
  if (value.allowed !== false) throw new Error('auditContextInsufficientFinding requires a blocked budget');
  return Object.freeze({
    id: 'DV2-AUDIT-CONTEXT-INSUFFICIENT',
    severity: 'high',
    violatedContract: 'DV2-008 bounded independent audit context must fail closed when material contract context is omitted',
    surface: 'audit-bundle',
    failureMode: `The bounded audit bundle cannot safely represent all material issue/PR context: ${value.reasons.join(', ')}`,
    evidence: `bundleBytes=${value.totalBytes}; maxTotalBytes=${value.limits.maxTotalBytes}; reasons=${value.reasons.join(',')}`,
    remediationMode: 'targeted',
    blocksRelease: true,
    candidateSha: sha
  });
}
