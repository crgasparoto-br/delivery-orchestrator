import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AI_ROLE_POLICY,
  resolveAiProvider,
  resolveProviderSelection,
  resolveProviderSelectionForRisk
} from '../src/v2/provider-policy.mjs';

for (const provider of ['codex', 'claude', 'copilot']) {
  test(`accepts ${provider}`, () => assert.equal(resolveAiProvider(provider), provider));
}

test('rejects unsupported provider without fallback', () => {
  assert.throws(() => resolveAiProvider('other'), /must be one of: codex, claude, copilot/);
});

test('allows distinct implementer and auditor providers', () => {
  const selection = resolveProviderSelection({ provider: 'copilot', implementerProvider: 'codex', auditorProvider: 'claude' });
  assert.equal(selection.implementer.provider, 'codex');
  assert.equal(selection.auditor.provider, 'claude');
  assert.equal(selection.implementer.runtime, 'github-agentic-workflows');
});

test('risk-specific implementer variables override general role variables', () => {
  const selection = resolveProviderSelectionForRisk({
    implementerProvider: 'copilot',
    implementerModel: 'general-model',
    criticalImplementerProvider: 'claude',
    criticalImplementerModel: 'critical-model'
  }, 'critical');
  assert.equal(selection.implementer.provider, 'claude');
  assert.equal(selection.implementer.model, 'critical-model');
  assert.equal(selection.implementer.providerSource, 'DELIVERY_CRITICAL_IMPLEMENTER_PROVIDER');
  assert.equal(selection.implementer.modelSource, 'DELIVERY_CRITICAL_IMPLEMENTER_MODEL');
});

test('risk-specific auditor variables override general role variables', () => {
  const selection = resolveProviderSelectionForRisk({
    auditorProvider: 'codex',
    auditorModel: 'general-audit-model',
    standardAuditorProvider: 'copilot',
    standardAuditorModel: 'focused-audit-model'
  }, 'standard');
  assert.equal(selection.auditor.provider, 'copilot');
  assert.equal(selection.auditor.model, 'focused-audit-model');
  assert.equal(selection.auditor.providerSource, 'DELIVERY_STANDARD_AUDITOR_PROVIDER');
  assert.equal(selection.auditor.modelSource, 'DELIVERY_STANDARD_AUDITOR_MODEL');
});

test('general role variables override compatibility inputs', () => {
  const selection = resolveProviderSelectionForRisk({
    provider: 'codex',
    model: 'legacy-model',
    implementerProvider: 'claude',
    implementerModel: 'role-model'
  }, 'fast');
  assert.equal(selection.implementer.provider, 'claude');
  assert.equal(selection.implementer.model, 'role-model');
  assert.equal(selection.implementer.providerSource, 'DELIVERY_IMPLEMENTER_PROVIDER');
  assert.equal(selection.implementer.modelSource, 'DELIVERY_IMPLEMENTER_MODEL');
});

test('uses concrete versioned defaults when GitHub variables are absent', () => {
  const selection = resolveProviderSelectionForRisk({}, 'critical');
  assert.deepEqual(
    { provider: selection.implementer.provider, model: selection.implementer.model },
    {
      provider: DEFAULT_AI_ROLE_POLICY.implementer.provider,
      model: DEFAULT_AI_ROLE_POLICY.implementer.models[DEFAULT_AI_ROLE_POLICY.implementer.provider]
    }
  );
  assert.deepEqual(
    { provider: selection.auditor.provider, model: selection.auditor.model },
    {
      provider: DEFAULT_AI_ROLE_POLICY.auditor.provider,
      model: DEFAULT_AI_ROLE_POLICY.auditor.models[DEFAULT_AI_ROLE_POLICY.auditor.provider]
    }
  );
  assert.equal(selection.implementer.providerSource, 'versioned-default');
  assert.equal(selection.implementer.modelSource, 'versioned-default');
  assert.equal(selection.auditor.providerSource, 'versioned-default');
  assert.equal(selection.auditor.modelSource, 'versioned-default');
});

test('never marks model fallback as allowed', () => {
  const selection = resolveProviderSelectionForRisk({}, 'standard');
  assert.equal(selection.implementer.modelFallbackAllowed, false);
  assert.equal(selection.auditor.modelFallbackAllowed, false);
});

test('rejects invalid risk-specific provider instead of falling back', () => {
  assert.throws(() => resolveProviderSelectionForRisk({
    criticalImplementerProvider: 'unknown',
    implementerProvider: 'codex'
  }, 'critical'), /must be one of: codex, claude, copilot/);
});

test('rejects multiline model names instead of normalizing them', () => {
  assert.throws(() => resolveProviderSelectionForRisk({
    standardAuditorModel: 'model-a\nmodel-b'
  }, 'standard'), /single non-empty value/);
});
