import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_DISCOVERY_POLICY = Object.freeze({
  mode: 'deterministic-scope-discovery',
  aiTurns: 0,
  aiCredits: 0,
  providerCalls: 0
});

export function createDispatchDecision(plan) {
  if (!plan || plan.architecture !== 'github-native-v2') {
    throw new Error('Expected github-native-v2 delivery plan');
  }
  const risk = plan.risk;
  if (!risk || typeof risk !== 'object') throw new Error('plan.risk is required');
  const policy = executionPolicyFor(risk.profile);

  if (risk.requested === 'auto' && risk.provisional === true) {
    return Object.freeze({
      dispatchAllowed: false,
      stage: 'scope-discovery',
      securityProfile: risk.profile,
      nextAction: 'collect-concrete-changed-paths',
      reason: 'auto-risk-without-concrete-paths',
      discovery: DELIVERY_V2_DISCOVERY_POLICY,
      materialWorkerBudget: Object.freeze({ turns: 0, credits: 0, attempts: 0 }),
      failClosed: true
    });
  }

  return Object.freeze({
    dispatchAllowed: true,
    stage: 'implementation',
    securityProfile: risk.profile,
    nextAction: 'dispatch-material-worker',
    reason: risk.promoted ? 'observed-risk-promotion' : 'risk-resolved',
    discovery: null,
    materialWorkerBudget: Object.freeze({
      turns: policy.maxAiTurns,
      credits: policy.maxAiCredits,
      attempts: policy.maxImplementationAttempts
    }),
    failClosed: true
  });
}
