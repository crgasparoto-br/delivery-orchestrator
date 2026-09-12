import { DELIVERY_V2_AUDIT_SCHEMA_VERSION } from './audit-contract.mjs';
import { executionPolicyFor } from './execution-policy.mjs';
import { resolveImplementationWorkflow } from './provider-dispatch.mjs';
import { resolveRiskProfile } from './risk-profile.mjs';

export function createDeliveryPlan(config) {
  const risk = resolveRiskProfile({
    requested: config.requestedRisk,
    changedPaths: config.changedPaths,
    repositoryPolicy: config.repositoryPolicy
  });
  const policy = executionPolicyFor(risk.profile);
  const workflow = resolveImplementationWorkflow(config.providers.implementer.provider, risk.profile);
  return {
    schemaVersion: 2,
    architecture: 'github-native-v2',
    repository: config.repository ?? null,
    issueNumber: config.issueNumber ?? null,
    risk,
    implementation: {
      ...config.providers.implementer,
      workflow,
      maxAttempts: policy.maxImplementationAttempts,
      maxTurns: policy.maxAiTurns,
      maxAiCredits: policy.maxAiCredits
    },
    audit: {
      required: policy.auditRequired,
      mode: policy.auditMode,
      ...config.providers.auditor,
      maxAttempts: policy.maxAuditAttempts,
      contractSchemaVersion: DELIVERY_V2_AUDIT_SCHEMA_VERSION,
      exactMaterialShaRequired: true,
      independentContextRequired: risk.profile === 'critical',
      legacyV1HandoffRequired: false
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
      noAutomaticMerge: true,
      agentWriteTokenExposed: false
    }
  };
}
