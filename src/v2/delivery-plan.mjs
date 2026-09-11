import { executionPolicyFor } from './execution-policy.mjs';
import { resolveRiskProfile } from './risk-profile.mjs';

export function createDeliveryPlan(config) {
  const risk = resolveRiskProfile({ requested: config.requestedRisk, changedPaths: config.changedPaths });
  const policy = executionPolicyFor(risk.profile);
  return {
    schemaVersion: 1,
    architecture: 'github-native-v2',
    repository: config.repository ?? null,
    issueNumber: config.issueNumber ?? null,
    risk,
    implementation: {
      ...config.providers.implementer,
      maxAttempts: policy.maxImplementationAttempts,
      maxTurns: policy.maxAiTurns,
      maxAiCredits: policy.maxAiCredits
    },
    audit: {
      required: policy.auditRequired,
      mode: policy.auditMode,
      ...config.providers.auditor,
      maxAttempts: policy.maxAuditAttempts
    },
    ci: {
      mode: policy.ciMode,
      fullRegressionOnPr: policy.fullRegressionOnPr,
      fullRegressionAfterMerge: policy.fullRegressionAfterMerge
    },
    escalation: policy.escalation,
    controls: {
      deterministicControlPlane: true,
      noSilentProviderFallback: true,
      noAutomaticMerge: true
    }
  };
}
