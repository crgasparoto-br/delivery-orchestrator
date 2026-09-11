const POLICIES = Object.freeze({
  fast: Object.freeze({
    ciMode: 'focused',
    auditRequired: false,
    auditMode: 'none',
    maxImplementationAttempts: 2,
    maxAuditAttempts: 0,
    maxAiTurns: 20,
    maxAiCredits: 100,
    escalation: 'standard',
    fullRegressionOnPr: false,
    fullRegressionAfterMerge: true
  }),
  standard: Object.freeze({
    ciMode: 'affected-plus-build',
    auditRequired: true,
    auditMode: 'focused-independent',
    maxImplementationAttempts: 2,
    maxAuditAttempts: 1,
    maxAiTurns: 40,
    maxAiCredits: 250,
    escalation: 'critical',
    fullRegressionOnPr: false,
    fullRegressionAfterMerge: true
  }),
  critical: Object.freeze({
    ciMode: 'full',
    auditRequired: true,
    auditMode: 'independent',
    maxImplementationAttempts: 3,
    maxAuditAttempts: 2,
    maxAiTurns: 80,
    maxAiCredits: 500,
    escalation: 'human',
    fullRegressionOnPr: true,
    fullRegressionAfterMerge: true
  })
});

export function executionPolicyFor(profile) {
  const policy = POLICIES[profile];
  if (!policy) throw new Error(`Unknown risk profile: ${profile}`);
  return { profile, ...policy };
}
