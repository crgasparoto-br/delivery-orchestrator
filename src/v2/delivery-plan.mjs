import { DELIVERY_V2_AUDIT_SCHEMA_VERSION } from './audit-contract.mjs';
import { resolveOperationalAuditPolicy } from './audit-policy.mjs';
import { executionPolicyFor } from './execution-policy.mjs';
import { resolveProviderSelectionForRisk } from './provider-policy.mjs';
import { DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION, DELIVERY_V2_RELEASE_STATUS_NAME } from './release-gate.mjs';
import { DELIVERY_V2_TECHNICAL_HYGIENE_SCHEMA_VERSION } from './technical-hygiene.mjs';
import { resolveImplementationWorkflow } from './provider-dispatch.mjs';
import { resolveRiskProfile } from './risk-profile.mjs';

function aiPolicyFromConfig(config) {
  if (config.aiPolicy) return config.aiPolicy;
  return Object.freeze({
    implementerProvider: config.providers?.implementer?.provider,
    implementerModel: config.providers?.implementer?.model,
    auditorProvider: config.providers?.auditor?.provider,
    auditorModel: config.providers?.auditor?.model
  });
}

export function createDeliveryPlan(config) {
  const risk = resolveRiskProfile({
    requested: config.requestedRisk,
    changedPaths: config.changedPaths,
    repositoryPolicy: config.repositoryPolicy
  });
  const providers = resolveProviderSelectionForRisk(aiPolicyFromConfig(config), risk.profile);
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
    hygiene: {
      required: true,
      contractSchemaVersion: DELIVERY_V2_TECHNICAL_HYGIENE_SCHEMA_VERSION,
      reuseFirst: true,
      boundedDiscovery: true,
      exactMaterialShaRequired: true,
      initialBaselineRequired: true,
      remediationPreviousMaterialRequired: true,
      allowedResultsForRelease: ['PASS', 'PASS_WITH_DEBT'],
      materialUnknownPromotesFastToAtLeastStandard: true,
      materialUnknownBlocksRelease: true,
      semanticJudgmentRequiresEvidence: true,
      deterministicFactsTakePrecedence: true
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
      technicalHygieneRequired: true,
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
      agentWriteTokenExposed: false,
      noStructuralRegression: true,
      localPolicyCannotWeakenHygiene: true
    }
  };
}
