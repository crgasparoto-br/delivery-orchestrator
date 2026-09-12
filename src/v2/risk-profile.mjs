import { normalizeRepositoryRiskPolicy, pathWithinRoot } from './repository-risk-policy.mjs';

export const RISK_PROFILES = Object.freeze(['fast', 'standard', 'critical']);
export const REQUESTED_RISK_PROFILES = Object.freeze(['auto', ...RISK_PROFILES]);
const REQUESTED_SET = new Set(REQUESTED_RISK_PROFILES);
const RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });

const CORE_CRITICAL_PATTERNS = [
  /^\.github\/(workflows|actions)\//,
  /(^|\/)(prisma|migrations|auth|authentication|security|permissions|authorization|billing|payments?|finance|database|db)(\/|$)/,
  /(^|\/)(dockerfile|docker-compose(?:\.[^/]+)?|render\.yaml|vercel\.json)$/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)packages\/(shared|domain|config)(\/|$)/
];

const CORE_SENSITIVE_ENTRYPOINT_PATTERNS = [
  /(^|\/)(login|logout|signin|sign-in|signout|sign-out)(?:[._-]|$)/,
  /(^|\/)[^/]*(authstore|authprovider|authcontext|protectedroute|routeguard|sessionstore|identityprovider|permissionadapter|accesscontrol|credential|secret)[^/]*$/
];

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function firstMatchingRoot(path, roots) {
  return roots.find((root) => pathWithinRoot(path, root)) ?? null;
}

function classifyPath(path, repositoryPolicy) {
  if (CORE_CRITICAL_PATTERNS.some((pattern) => pattern.test(path))) {
    return { profile: 'critical', reason: `core-critical-path:${path}` };
  }
  if (CORE_SENSITIVE_ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(path))) {
    return { profile: 'critical', reason: `core-sensitive-boundary:${path}` };
  }
  if (repositoryPolicy.criticalPaths.includes(path)) {
    return { profile: 'critical', reason: `repository-critical-path:${path}` };
  }

  const criticalRoot = firstMatchingRoot(path, repositoryPolicy.criticalRoots);
  if (criticalRoot) {
    return { profile: 'critical', reason: `repository-critical-root:${criticalRoot}:${path}` };
  }

  const fastRoot = firstMatchingRoot(path, repositoryPolicy.fastSafeRoots);
  if (fastRoot) {
    return { profile: 'fast', reason: `repository-fast-safe-root:${fastRoot}:${path}` };
  }

  const standardRoot = firstMatchingRoot(path, repositoryPolicy.standardRoots);
  if (standardRoot) {
    return { profile: 'standard', reason: `repository-standard-root:${standardRoot}:${path}` };
  }

  return { profile: 'critical', reason: `unknown-path:${path}` };
}

export function resolveRequestedRiskProfile(value) {
  const resolved = String(value || 'auto').trim().toLowerCase();
  if (!REQUESTED_SET.has(resolved)) {
    throw new Error(`DELIVERY_RISK_PROFILE must be one of: ${REQUESTED_RISK_PROFILES.join(', ')}`);
  }
  return resolved;
}

export function classifyChangedPaths(changedPaths = [], { repositoryPolicy = {} } = {}) {
  const paths = [...new Set(changedPaths.map(normalizePath).filter(Boolean))];
  const normalizedPolicy = normalizeRepositoryRiskPolicy(repositoryPolicy);
  if (paths.length === 0) {
    return {
      profile: 'critical',
      provisional: true,
      reasons: ['no-changed-paths-fail-closed'],
      paths: []
    };
  }

  const classified = paths.map((path) => classifyPath(path, normalizedPolicy));
  const highest = classified.reduce(
    (best, item) => (RANK[item.profile] > RANK[best] ? item.profile : best),
    'fast'
  );
  return {
    profile: highest,
    provisional: false,
    reasons: classified.filter((item) => item.profile === highest).map((item) => item.reason),
    paths
  };
}

export function resolveRiskProfile({ requested = 'auto', changedPaths = [], repositoryPolicy = {} } = {}) {
  const requestedProfile = resolveRequestedRiskProfile(requested);
  const observed = classifyChangedPaths(changedPaths, { repositoryPolicy });
  if (requestedProfile === 'auto') {
    return { requested: requestedProfile, ...observed, promoted: false };
  }

  const promoted = RANK[observed.profile] > RANK[requestedProfile];
  const profile = promoted ? observed.profile : requestedProfile;
  return {
    requested: requestedProfile,
    profile,
    provisional: observed.provisional,
    promoted,
    reasons: promoted
      ? [`promoted:${requestedProfile}->${profile}`, ...observed.reasons]
      : [`explicit:${requestedProfile}`, ...observed.reasons],
    paths: observed.paths
  };
}
