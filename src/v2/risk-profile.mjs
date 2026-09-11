export const RISK_PROFILES = Object.freeze(['fast', 'standard', 'critical']);
export const REQUESTED_RISK_PROFILES = Object.freeze(['auto', ...RISK_PROFILES]);
const REQUESTED_SET = new Set(REQUESTED_RISK_PROFILES);
const RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });

const CRITICAL_PATTERNS = [
  /^\.github\/(workflows|actions)\//,
  /(^|\/)(prisma|migrations|auth|authentication|security|permissions|authorization|billing|payments?|finance|database|db)(\/|$)/,
  /(^|\/)(dockerfile|docker-compose(?:\.[^/]+)?|render\.yaml|vercel\.json)$/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)packages\/(shared|domain|config)(\/|$)/
];

const FAST_PATTERNS = [
  /^docs\//,
  /\.md$/,
  /(^|\/)(styles?|assets?)\//,
  /\.(css|scss|sass|less|svg|png|jpe?g|webp)$/,
  /^apps\/web\/src\/(components|views|screens)\//
];

const STANDARD_PATTERNS = [
  /^apps\/[a-z0-9_-]+\/src\//,
  /^src\//,
  /(^|\/)(test|tests|__tests__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/
];

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function classifyPath(path) {
  if (CRITICAL_PATTERNS.some((pattern) => pattern.test(path))) return { profile: 'critical', reason: `critical-path:${path}` };
  if (FAST_PATTERNS.some((pattern) => pattern.test(path))) return { profile: 'fast', reason: `fast-path:${path}` };
  if (STANDARD_PATTERNS.some((pattern) => pattern.test(path))) return { profile: 'standard', reason: `standard-path:${path}` };
  return { profile: 'critical', reason: `unknown-path:${path}` };
}

export function resolveRequestedRiskProfile(value) {
  const resolved = String(value || 'auto').trim().toLowerCase();
  if (!REQUESTED_SET.has(resolved)) {
    throw new Error(`DELIVERY_RISK_PROFILE must be one of: ${REQUESTED_RISK_PROFILES.join(', ')}`);
  }
  return resolved;
}

export function classifyChangedPaths(changedPaths = []) {
  const paths = [...new Set(changedPaths.map(normalizePath).filter(Boolean))];
  if (paths.length === 0) {
    return { profile: 'standard', provisional: true, reasons: ['no-changed-paths-yet'], paths: [] };
  }
  const classified = paths.map(classifyPath);
  const highest = classified.reduce((best, item) => RANK[item.profile] > RANK[best] ? item.profile : best, 'fast');
  return {
    profile: highest,
    provisional: false,
    reasons: classified.filter((item) => item.profile === highest).map((item) => item.reason),
    paths
  };
}

export function resolveRiskProfile({ requested = 'auto', changedPaths = [] } = {}) {
  const requestedProfile = resolveRequestedRiskProfile(requested);
  const observed = classifyChangedPaths(changedPaths);
  if (requestedProfile === 'auto') {
    return { requested: requestedProfile, ...observed, promoted: false };
  }
  if (observed.provisional) {
    return {
      requested: requestedProfile,
      profile: requestedProfile,
      provisional: true,
      promoted: false,
      reasons: [`explicit:${requestedProfile}`, ...observed.reasons],
      paths: observed.paths
    };
  }
  const promoted = RANK[observed.profile] > RANK[requestedProfile];
  const profile = promoted ? observed.profile : requestedProfile;
  return {
    requested: requestedProfile,
    profile,
    provisional: false,
    promoted,
    reasons: promoted ? [`promoted:${requestedProfile}->${profile}`, ...observed.reasons] : [`explicit:${requestedProfile}`, ...observed.reasons],
    paths: observed.paths
  };
}
