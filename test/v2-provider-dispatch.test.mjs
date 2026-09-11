import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImplementationWorkflow, createImplementationDispatch } from '../src/v2/provider-dispatch.mjs';

for (const provider of ['copilot', 'codex', 'claude']) {
  for (const profile of ['fast', 'standard', 'critical']) {
    test(`${provider}/${profile} resolves one exact worker`, () => {
      assert.equal(resolveImplementationWorkflow(provider, profile), `delivery-v2-worker-${provider}-${profile}.lock.yml`);
    });
  }
}

test('dispatch preserves deterministic FAST budget', () => {
  assert.deepEqual(createImplementationDispatch({
    architecture: 'github-native-v2', risk: { profile: 'fast' }, implementation: { provider: 'claude' }
  }), {
    provider: 'claude', riskProfile: 'fast', workflow: 'delivery-v2-worker-claude-fast.lock.yml',
    maxTurns: 20, maxAiCredits: 100, maxAttempts: 2, noAutomaticMerge: true
  });
});

test('invalid provider fails closed', () => {
  assert.throws(() => resolveImplementationWorkflow('random-ai', 'fast'), /must be one of/);
});

test('invalid risk fails closed', () => {
  assert.throws(() => resolveImplementationWorkflow('copilot', 'tiny'), /Unknown risk profile/);
});
