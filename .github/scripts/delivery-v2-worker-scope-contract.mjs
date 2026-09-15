import { createHash } from 'node:crypto';

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

export function normalizeScopePath(value) {
  const original = requiredString(value, 'scope path');
  if (original.includes('\0')) throw new Error('scope path must not contain NUL');
  if (original.includes('\\')) throw new Error(`scope path must use repository separators: ${original}`);
  if (original.startsWith('/') || /^[A-Za-z]:\//.test(original)) throw new Error(`scope path must be repository-relative: ${original}`);
  const directory = original.endsWith('/');
  const withoutPrefix = original.replace(/^\.\//, '');
  const raw = directory ? withoutPrefix.slice(0, -1) : withoutPrefix;
  const segments = raw.split('/');
  if (!raw || segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`scope path is not canonical: ${original}`);
  return directory ? `${segments.join('/')}/` : segments.join('/');
}

export function normalizeScopePaths(values = []) {
  if (!Array.isArray(values)) throw new Error('authorizedPaths must be an array');
  return [...new Set(values.map(normalizeScopePath))].sort();
}

export function issueContractFingerprint({ repository, issueNumber, title = '', body = '' } = {}) {
  const canonical = JSON.stringify({
    repository: requiredString(repository, 'repository'),
    issueNumber: requiredPositiveInteger(issueNumber, 'issueNumber'),
    title: String(title ?? ''),
    body: String(body ?? '')
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function createWorkerScopeBinding({ repository, issue, authorizedPaths = [] } = {}) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('issue is required');
  const issueNumber = requiredPositiveInteger(issue.number, 'issue.number');
  const normalizedPaths = normalizeScopePaths(authorizedPaths);
  return Object.freeze({
    schemaVersion: 1,
    repository: requiredString(repository, 'repository'),
    issueNumber,
    issueContractSha256: issueContractFingerprint({ repository, issueNumber, title: issue.title, body: issue.body }),
    enforcement: normalizedPaths.length ? 'explicit-exclusive' : 'issue-contract-only',
    authorizedPaths: normalizedPaths
  });
}

export function validateWorkerScopeBinding(binding, { repository, issue } = {}) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('scope binding is required');
  if (Number(binding.schemaVersion) !== 1) throw new Error('unsupported scope binding schemaVersion');
  const expected = createWorkerScopeBinding({ repository, issue, authorizedPaths: binding.authorizedPaths ?? [] });
  if (String(binding.repository ?? '') !== expected.repository) throw new Error('scope binding repository mismatch');
  if (Number(binding.issueNumber) !== expected.issueNumber) throw new Error('scope binding issue mismatch');
  if (String(binding.issueContractSha256 ?? '') !== expected.issueContractSha256) throw new Error('scope binding issue contract changed');
  if (String(binding.enforcement ?? '') !== expected.enforcement) throw new Error('scope binding enforcement mismatch');
  return expected;
}

export function pathWithinAuthorizedScope(filePath, authorizedPaths = []) {
  const normalized = normalizeScopePath(filePath);
  const allowed = normalizeScopePaths(authorizedPaths);
  return allowed.some((entry) => entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry);
}

export function assertChangedPathsAuthorized(changedPaths, binding) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('candidate patch has no changed paths');
  const normalizedChanged = normalizeScopePaths(changedPaths);
  const enforcement = String(binding?.enforcement ?? '');
  if (enforcement === 'issue-contract-only') return Object.freeze({ changedPaths: normalizedChanged, authorizedPaths: [] });
  if (enforcement !== 'explicit-exclusive') throw new Error(`unsupported scope enforcement: ${enforcement}`);
  const authorizedPaths = normalizeScopePaths(binding?.authorizedPaths ?? []);
  if (authorizedPaths.length === 0) throw new Error('explicit scope enforcement requires authorizedPaths');
  const unauthorized = normalizedChanged.filter((filePath) => !pathWithinAuthorizedScope(filePath, authorizedPaths));
  if (unauthorized.length) throw new Error(`candidate patch escapes controller-authorized scope: ${unauthorized.join(', ')}; authorized: ${authorizedPaths.join(', ')}`);
  return Object.freeze({ changedPaths: normalizedChanged, authorizedPaths });
}
