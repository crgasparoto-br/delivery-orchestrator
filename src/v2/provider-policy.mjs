export const AI_PROVIDERS = Object.freeze(['codex', 'claude', 'copilot']);
const PROVIDER_SET = new Set(AI_PROVIDERS);

const METADATA = Object.freeze({
  codex: Object.freeze({
    engine: 'codex',
    runtime: 'github-agentic-workflows',
    auth: 'CODEX_API_KEY or OPENAI_API_KEY (or GitHub Copilot-backed Codex when configured)'
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

export function resolveAiProvider(value, fallback = 'codex') {
  const resolved = String(value || fallback).trim().toLowerCase();
  if (!PROVIDER_SET.has(resolved)) {
    throw new Error(`DELIVERY_AI_PROVIDER must be one of: ${AI_PROVIDERS.join(', ')}`);
  }
  return resolved;
}

export function resolveProviderSelection({
  provider,
  implementerProvider,
  auditorProvider,
  model,
  implementerModel,
  auditorModel
} = {}) {
  const base = resolveAiProvider(provider, 'codex');
  const implementer = resolveAiProvider(implementerProvider, base);
  const auditor = resolveAiProvider(auditorProvider, base);
  return {
    implementer: { provider: implementer, model: implementerModel || model || 'auto', ...METADATA[implementer] },
    auditor: { provider: auditor, model: auditorModel || model || 'auto', ...METADATA[auditor] }
  };
}

export function providerMetadata(provider) {
  const resolved = resolveAiProvider(provider);
  return { provider: resolved, ...METADATA[resolved] };
}
