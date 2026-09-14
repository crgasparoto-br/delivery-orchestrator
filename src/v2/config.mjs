import { resolveRequestedRiskProfile } from './risk-profile.mjs';
import { normalizeRepositoryRiskPolicy } from './repository-risk-policy.mjs';

function splitPaths(value) {
  if (!value) return [];
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function parseRepositoryRiskPolicy(value) {
  if (!value) return normalizeRepositoryRiskPolicy({});
  if (typeof value === 'object') return normalizeRepositoryRiskPolicy(value);
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`DELIVERY_RISK_POLICY_JSON must be valid JSON: ${error.message}`);
  }
  return normalizeRepositoryRiskPolicy(parsed);
}

export function loadV2Config(args = {}, env = process.env) {
  const requestedRisk = resolveRequestedRiskProfile(args.risk ?? env.DELIVERY_RISK_PROFILE ?? 'auto');
  const changedPaths = args.changedPaths?.length ? args.changedPaths : splitPaths(env.DELIVERY_CHANGED_PATHS);
  const repositoryPolicy = parseRepositoryRiskPolicy(args.riskPolicyJson ?? env.DELIVERY_RISK_POLICY_JSON);
  const aiPolicy = Object.freeze({
    provider: args.provider,
    model: args.model,
    implementerProvider: args.implementerProvider ?? env.DELIVERY_IMPLEMENTER_PROVIDER,
    implementerModel: args.implementerModel ?? env.DELIVERY_IMPLEMENTER_MODEL,
    auditorProvider: args.auditorProvider ?? env.DELIVERY_AUDITOR_PROVIDER,
    auditorModel: args.auditorModel ?? env.DELIVERY_AUDITOR_MODEL,
    fastImplementerProvider: args.fastImplementerProvider ?? env.DELIVERY_FAST_IMPLEMENTER_PROVIDER,
    fastImplementerModel: args.fastImplementerModel ?? env.DELIVERY_FAST_IMPLEMENTER_MODEL,
    standardImplementerProvider: args.standardImplementerProvider ?? env.DELIVERY_STANDARD_IMPLEMENTER_PROVIDER,
    standardImplementerModel: args.standardImplementerModel ?? env.DELIVERY_STANDARD_IMPLEMENTER_MODEL,
    criticalImplementerProvider: args.criticalImplementerProvider ?? env.DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER,
    criticalImplementerModel: args.criticalImplementerModel ?? env.DELIVERY_CRITICAL_IMPLEMENTER_MODEL,
    standardAuditorProvider: args.standardAuditorProvider ?? env.DELIVERY_STANDARD_AUDITOR_PROVIDER,
    standardAuditorModel: args.standardAuditorModel ?? env.DELIVERY_STANDARD_AUDITOR_MODEL,
    criticalAuditorProvider: args.criticalAuditorProvider ?? env.DELIVERY_CRITICAL_AUDITOR_PROVIDER,
    criticalAuditorModel: args.criticalAuditorModel ?? env.DELIVERY_CRITICAL_AUDITOR_MODEL
  });
  return {
    architecture: 'github-native-v2',
    aiPolicy,
    requestedRisk,
    changedPaths,
    repositoryPolicy,
    repository: args.repository ?? env.TARGET_REPOSITORY ?? null,
    issueNumber: Number.parseInt(args.issueNumber ?? env.TARGET_ISSUE ?? '', 10) || null
  };
}
