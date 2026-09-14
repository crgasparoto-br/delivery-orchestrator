export const AI_PROVIDERS = Object.freeze(['codex', 'claude', 'copilot']);
export const AI_RISK_PROFILES = Object.freeze(['fast', 'standard', 'critical']);

const PROVIDER_SET = new Set(AI_PROVIDERS);
const RISK_SET = new Set(AI_RISK_PROFILES);

const METADATA = Object.freeze({
  codex: Object.freeze({
    engine: 'codex',
    runtime: 'github-agentic-workflows',
    auth: 'CODEX_API_KEY or OPENAI_API_KEY'
  }),
  claude: Object.freeze({
    engine: 'claude',
    runtime: 'github-agentic-workflows',
    auth: 'ANTHROPIC_API_KEY or Anthropic workload identity federation'
  }),
  copilot: Object.freeze({
    engine: 'copilot',
    runtime: 'github-agentic-workflows',
    auth: 'copilot-requests: write or COPILOT_GITHUB_TOKEN'
  })
});

export const DEFAULT_AI_ROLE_POLICY = Object.freeze({
  implementer: Object.freeze({
    provider: 'copilot',
    models: Object.freeze({ codex: 'gpt-5.4', claude: 'claude-sonnet-5', copilot: 'gpt-5.3-codex' })
  }),
  auditor: Object.freeze({
    provider: 'codex',
    models: Object.freeze({ codex: 'gpt-5.6-sol', claude: 'claude-opus-5', copilot: 'gpt-5.3-codex' })
  })
});

function normalizeOptional(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function firstConfigured(entries) {
  for (const [value, source] of entries) {
    const normalized = normalizeOptional(value);
    if (normalized) return Object.freeze({ value: normalized, source });
  }
  return null;
}

function resolveRiskProfile(value) {
  const resolved = String(value ?? '').trim().toLowerCase();
  if (!RISK_SET.has(resolved)) {
    throw new Error(`AI risk profile must be one of: ${AI_RISK_PROFILES.join(', ')}`);
  }
  return resolved;
}

export function resolveAiProvider(value, fallback = 'codex') {
  const resolved = String(value || fallback).trim().toLowerCase();
  if (!PROVIDER_SET.has(resolved)) {
    throw new Error(`AI provider must be one of: ${AI_PROVIDERS.join(', ')}`);
  }
  return resolved;
}

export function resolveAiModel(value, { provider, role }) {
  const resolvedProvider = resolveAiProvider(provider);
  if (!['implementer', 'auditor'].includes(role)) throw new Error('AI role must be implementer or auditor');
  const configured = normalizeOptional(value);
  const resolved = configured || DEFAULT_AI_ROLE_POLICY[role].models[resolvedProvider];
  if (!resolved || /[\r\n]/.test(resolved)) throw new Error(`AI model for ${role}/${resolvedProvider} must be a single non-empty value`);
  return resolved;
}

export function resolveProviderSelectionForRisk({
  provider,
  model,
  implementerProvider,
  implementerModel,
  auditorProvider,
  auditorModel,
  fastImplementerProvider,
  fastImplementerModel,
  standardImplementerProvider,
  standardImplementerModel,
  criticalImplementerProvider,
  criticalImplementerModel,
  standardAuditorProvider,
  standardAuditorModel,
  criticalAuditorProvider,
  criticalAuditorModel
} = {}, riskProfile = 'standard') {
  const risk = resolveRiskProfile(riskProfile);
  const riskImplementerProvider = {
    fast: fastImplementerProvider,
    standard: standardImplementerProvider,
    critical: criticalImplementerProvider
  }[risk];
  const riskImplementerModel = {
    fast: fastImplementerModel,
    standard: standardImplementerModel,
    critical: criticalImplementerModel
  }[risk];
  const riskAuditorProvider = {
    fast: null,
    standard: standardAuditorProvider,
    critical: criticalAuditorProvider
  }[risk];
  const riskAuditorModel = {
    fast: null,
    standard: standardAuditorModel,
    critical: criticalAuditorModel
  }[risk];

  const implementerProviderChoice = firstConfigured([
    [riskImplementerProvider, `DELIVERY_${risk.toUpperCase()}_IMPLEMENTER_PROVIDER`],
    [implementerProvider, 'DELIVERY_IMPLEMENTER_PROVIDER'],
    [provider, 'explicit-provider'],
    [DEFAULT_AI_ROLE_POLICY.implementer.provider, 'versioned-default']
  ]);
  const implementer = resolveAiProvider(implementerProviderChoice.value);
  const implementerModelChoice = firstConfigured([
    [riskImplementerModel, `DELIVERY_${risk.toUpperCase()}_IMPLEMENTER_MODEL`],
    [implementerModel, 'DELIVERY_IMPLEMENTER_MODEL'],
    [model, 'explicit-model'],
    [DEFAULT_AI_ROLE_POLICY.implementer.models[implementer], 'versioned-default']
  ]);

  const auditorProviderChoice = firstConfigured([
    [riskAuditorProvider, risk === 'fast' ? null : `DELIVERY_${risk.toUpperCase()}_AUDITOR_PROVIDER`],
    [auditorProvider, 'DELIVERY_AUDITOR_PROVIDER'],
    [DEFAULT_AI_ROLE_POLICY.auditor.provider, 'versioned-default']
  ]);
  const auditor = resolveAiProvider(auditorProviderChoice.value);
  const auditorModelChoice = firstConfigured([
    [riskAuditorModel, risk === 'fast' ? null : `DELIVERY_${risk.toUpperCase()}_AUDITOR_MODEL`],
    [auditorModel, 'DELIVERY_AUDITOR_MODEL'],
    [DEFAULT_AI_ROLE_POLICY.auditor.models[auditor], 'versioned-default']
  ]);

  return Object.freeze({
    implementer: Object.freeze({
      provider: implementer,
      model: resolveAiModel(implementerModelChoice.value, { provider: implementer, role: 'implementer' }),
      providerSource: implementerProviderChoice.source,
      modelSource: implementerModelChoice.source,
      modelFallbackAllowed: false,
      ...METADATA[implementer]
    }),
    auditor: Object.freeze({
      provider: auditor,
      model: resolveAiModel(auditorModelChoice.value, { provider: auditor, role: 'auditor' }),
      providerSource: auditorProviderChoice.source,
      modelSource: auditorModelChoice.source,
      modelFallbackAllowed: false,
      ...METADATA[auditor]
    })
  });
}

export function resolveProviderSelection(options = {}) {
  return resolveProviderSelectionForRisk(options, 'standard');
}

export function providerMetadata(provider) {
  const resolved = resolveAiProvider(provider);
  return { provider: resolved, ...METADATA[resolved] };
}
