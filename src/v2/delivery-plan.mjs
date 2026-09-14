import { DELIVERY_V2_AUDIT_SCHEMA_VERSION } from './audit-contract.mjs';
import { resolveOperationalAuditPolicy } from './audit-policy.mjs';
import { executionPolicyFor } from './execution-policy.mjs';
import { resolveProviderSelectionForRisk } from './provider-policy.mjs';
import { DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION, DELIVERY_V2_RELEASE_STATUS_NAME } from './release-gate.mjs';
import { resolveImplementationWorkflow } from './provider-dispatch.mjs';
import { resolveRiskProfile } from './risk-profile.mjs';

export function createDeliveryPlan(config) {
  const risk = resolveRiskProfile({
    requested: config.requestedRisk,
    changedPaths: config.changedPaths,
    repositoryPolicy: config.repositoryPolicy
  });
  const providers = resolveProviderSelectionForRisk(config.aiPolicy, risk.profile);
  const policy = executionPolicyFor(risk.profile);
  const auditPolicy = resolveOperationalAuditPolicy({
    riskProfile: risk.profile,
    repository: config.repository,
    standardAuditRequired: config.standardAuditRequired
  });
  const workflow = resolveImplementationWorkflow(providers.implementer.provider, risk.profile);
  return {
    schemaVersion: 2,
    architecture: 'github-native-v2',
    repository: config.repository ?? null,
    issueNumber: config.issueNumber ?? null,
    risk,
    implementation: {
      ...providers.implementer,
      workflow,
      maxAttempts: policy.maxImplementationAttempts,
      maxTurns: policy.maxAiTurns,
      maxAiCredits: policy.maxAiCredits
    },
    audit: {
      ...providers.auditor,
      required: auditPolicy.required,
      mode: auditPolicy.mode,
      maxAttempts: auditPolicy.maxAttempts,
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
    release: {
      contractSchemaVersion: DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION,
      requiredStatusName: DELIVERY_V2_RELEASE_STATUS_NAME,
      exactRemoteHeadRequired: true,
      evidenceReferencesOnly: true,
      createsResultOnlyCommit: false,
      automaticMergeAllowed: false
    },
    escalation: policy.escalation,
    controls: {
      deterministicControlPlane: true,
      noSilentProviderFallback: true,
      noSilentModelFallback: true,
      githubVariablesOwnAiSelection: true,
      noAutomaticMerge: true,
      agentWriteTokenExposed: false
    }
  };
}
