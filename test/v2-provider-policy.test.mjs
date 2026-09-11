import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiProvider, resolveProviderSelection } from '../src/v2/provider-policy.mjs';

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
