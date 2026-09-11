import { resolveProviderSelection } from './provider-policy.mjs';
import { resolveRequestedRiskProfile } from './risk-profile.mjs';

function splitPaths(value) {
  if (!value) return [];
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

export function loadV2Config(args = {}, env = process.env) {
  const provider = args.provider ?? env.DELIVERY_AI_PROVIDER ?? 'codex';
  const implementerProvider = args.implementerProvider ?? env.DELIVERY_IMPLEMENTER_PROVIDER;
  const auditorProvider = args.auditorProvider ?? env.DELIVERY_AUDITOR_PROVIDER;
  const model = args.model ?? env.DELIVERY_AI_MODEL;
  const implementerModel = args.implementerModel ?? env.DELIVERY_IMPLEMENTER_MODEL;
  const auditorModel = args.auditorModel ?? env.DELIVERY_AUDITOR_MODEL;
  const requestedRisk = resolveRequestedRiskProfile(args.risk ?? env.DELIVERY_RISK_PROFILE ?? 'auto');
  const changedPaths = args.changedPaths?.length ? args.changedPaths : splitPaths(env.DELIVERY_CHANGED_PATHS);
  return {
    architecture: 'github-native-v2',
    providers: resolveProviderSelection({ provider, implementerProvider, auditorProvider, model, implementerModel, auditorModel }),
    requestedRisk,
    changedPaths,
    repository: args.repository ?? env.TARGET_REPOSITORY ?? null,
    issueNumber: Number.parseInt(args.issueNumber ?? env.TARGET_ISSUE ?? '', 10) || null
  };
}
