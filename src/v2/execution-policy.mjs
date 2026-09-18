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

function positiveIntegerLimit(env, name, fallback) {
  const raw = String(env?.[name] ?? '').trim();
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function profilePrefix(profile) {
  return String(profile).toUpperCase();
}

export function executionPolicyFor(profile, env = process.env) {
  const policy = POLICIES[profile];

  if (!policy) {
    throw new Error(`Unknown risk profile: ${profile}`);
  }

  const prefix = profilePrefix(profile);

  return {
    profile,
    ...policy,
    maxImplementationAttempts: positiveIntegerLimit(
      env,
      `DELIVERY_${prefix}_MAX_IMPLEMENTATION_ATTEMPTS`,
      policy.maxImplementationAttempts
    ),
    maxAiTurns: positiveIntegerLimit(
      env,
      `DELIVERY_${prefix}_MAX_AI_TURNS`,
      policy.maxAiTurns
    ),
    maxAiCredits: positiveIntegerLimit(
      env,
      `DELIVERY_${prefix}_MAX_AI_CREDITS`,
      policy.maxAiCredits
    )
  };
}
