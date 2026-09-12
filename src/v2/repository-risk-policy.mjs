const POLICY_KEYS = new Set(['fastSafeRoots', 'standardRoots', 'criticalRoots', 'criticalPaths', 'criticalPathFragments']);

function normalizePolicyPath(value, field) {
  const normalized = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  if (!normalized || normalized === '.') {
    throw new Error(`${field} entries must be non-empty repository-relative paths`);
  }
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${field} entries must stay inside the repository`);
  }
  if (/[*?{}[\]]/.test(normalized)) {
    throw new Error(`${field} entries use exact/prefix matching; glob syntax is not supported`);
  }
  return normalized;
}

function normalizePathList(policy, field) {
  const value = policy[field] ?? [];
  if (!Array.isArray(value)) throw new Error(`repository risk policy ${field} must be an array`);
  return [...new Set(value.map((item) => normalizePolicyPath(item, field)))];
}

export function normalizeRepositoryRiskPolicy(policy = {}) {
  if (policy === null || Array.isArray(policy) || typeof policy !== 'object') {
    throw new Error('repository risk policy must be an object');
  }

  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) {
      throw new Error(`unsupported repository risk policy field: ${key}`);
    }
  }

  return Object.freeze({
    fastSafeRoots: Object.freeze(normalizePathList(policy, 'fastSafeRoots')),
    standardRoots: Object.freeze(normalizePathList(policy, 'standardRoots')),
    criticalRoots: Object.freeze(normalizePathList(policy, 'criticalRoots')),
    criticalPaths: Object.freeze(normalizePathList(policy, 'criticalPaths')),
    criticalPathFragments: Object.freeze(normalizePathList(policy, 'criticalPathFragments'))
  });
}

export function pathWithinRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}
