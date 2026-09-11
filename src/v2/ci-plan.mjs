import { resolveRiskProfile } from './risk-profile.mjs';
import { executionPolicyFor } from './execution-policy.mjs';

const STAGES = Object.freeze({
  fast: Object.freeze({
    lint: 'affected',
    typecheck: 'affected',
    tests: 'focused',
    build: 'affected'
  }),
  standard: Object.freeze({
    lint: 'affected',
    typecheck: 'affected',
    tests: 'affected',
    build: 'full'
  }),
  critical: Object.freeze({
    lint: 'full',
    typecheck: 'full',
    tests: 'full',
    build: 'full'
  })
});

export function buildCiPlan({ requested = 'auto', changedPaths = [] } = {}) {
  const risk = resolveRiskProfile({ requested, changedPaths });
  const policy = executionPolicyFor(risk.profile);
  return {
    schemaVersion: 1,
    requestedRisk: risk.requested,
    riskProfile: risk.profile,
    promoted: risk.promoted,
    provisional: risk.provisional,
    reasons: risk.reasons,
    changedPaths: risk.paths,
    ciMode: policy.ciMode,
    auditRequired: policy.auditRequired,
    auditMode: policy.auditMode,
    fullRegressionOnPr: policy.fullRegressionOnPr,
    fullRegressionAfterMerge: policy.fullRegressionAfterMerge,
    stages: { ...STAGES[risk.profile] }
  };
}
