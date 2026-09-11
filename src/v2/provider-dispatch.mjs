import { resolveAiProvider } from './provider-policy.mjs';
import { executionPolicyFor } from './execution-policy.mjs';

const WORKFLOW_BY_PROVIDER_AND_RISK = Object.freeze({
  copilot: Object.freeze({
    fast: 'delivery-v2-worker-copilot-fast.lock.yml',
    standard: 'delivery-v2-worker-copilot-standard.lock.yml',
    critical: 'delivery-v2-worker-copilot-critical.lock.yml'
  }),
  codex: Object.freeze({
    fast: 'delivery-v2-worker-codex-fast.lock.yml',
    standard: 'delivery-v2-worker-codex-standard.lock.yml',
    critical: 'delivery-v2-worker-codex-critical.lock.yml'
  }),
  claude: Object.freeze({
    fast: 'delivery-v2-worker-claude-fast.lock.yml',
    standard: 'delivery-v2-worker-claude-standard.lock.yml',
    critical: 'delivery-v2-worker-claude-critical.lock.yml'
  })
});

export function resolveImplementationWorkflow(provider, riskProfile) {
  const resolvedProvider = resolveAiProvider(provider);
  executionPolicyFor(riskProfile);
  return WORKFLOW_BY_PROVIDER_AND_RISK[resolvedProvider][riskProfile];
}

export function createImplementationDispatch(plan) {
  if (plan?.architecture !== 'github-native-v2') throw new Error('Expected github-native-v2 delivery plan');
  const provider = resolveAiProvider(plan?.implementation?.provider);
  const riskProfile = plan?.risk?.profile;
  const policy = executionPolicyFor(riskProfile);
  return {
    provider,
    riskProfile,
    workflow: resolveImplementationWorkflow(provider, riskProfile),
    maxTurns: policy.maxAiTurns,
    maxAiCredits: policy.maxAiCredits,
    maxAttempts: policy.maxImplementationAttempts,
    noAutomaticMerge: true
  };
}
