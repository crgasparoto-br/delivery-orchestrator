import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexExecutor } from '../src/codex-executor.mjs';

function withAuditEnv(values, fn) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] == null) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

const commonRun = Object.freeze({
  workingDirectory: '/tmp/audit-bundle',
  codexHome: '/tmp/auditor-home',
  prompt: 'audit',
  outputSchema: { type: 'object' },
  role: 'auditor',
  sandboxMode: 'read-only',
  networkAccessEnabled: false
});

test('routes Claude auditor with the exact resolved model', async () => {
  await withAuditEnv({ DELIVERY_AUDITOR_PROVIDER: 'claude', DELIVERY_AUDITOR_MODEL_RESOLVED: 'claude-opus-5' }, async () => {
    const calls = [];
    const executor = new CodexExecutor({
      provider: 'claude',
      anthropicApiKey: 'test-key',
      implementerUser: 'delivery-implementer',
      auditorUser: 'delivery-auditor',
      runRoleTaskFn: async (...args) => {
        calls.push(args);
        return { result: { decision: 'approved', findings: [] } };
      }
    });
    await executor.runFresh(commonRun);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'run-anthropic');
    assert.equal(calls[0][2].provider, 'claude');
    assert.equal(calls[0][2].model, 'claude-opus-5');
  });
});

test('routes Copilot auditor with the exact resolved model', async () => {
  await withAuditEnv({ DELIVERY_AUDITOR_PROVIDER: 'copilot', DELIVERY_AUDITOR_MODEL_RESOLVED: 'gpt-5.3-codex' }, async () => {
    const calls = [];
    const executor = new CodexExecutor({
      provider: 'copilot',
      copilotToken: 'test-token',
      implementerUser: 'delivery-implementer',
      auditorUser: 'delivery-auditor',
      runRoleTaskFn: async (...args) => {
        calls.push(args);
        return { result: { decision: 'approved', findings: [] } };
      }
    });
    await executor.runFresh(commonRun);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'run-copilot');
    assert.equal(calls[0][2].provider, 'copilot');
    assert.equal(calls[0][2].model, 'gpt-5.3-codex');
  });
});

test('fails closed when Claude auditor credential is missing', async () => {
  await withAuditEnv({ DELIVERY_AUDITOR_PROVIDER: 'claude', DELIVERY_AUDITOR_MODEL_RESOLVED: 'claude-opus-5', ANTHROPIC_API_KEY: null }, async () => {
    assert.throws(() => new CodexExecutor({
      provider: 'claude',
      anthropicApiKey: '',
      implementerUser: 'delivery-implementer',
      auditorUser: 'delivery-auditor'
    }), /ANTHROPIC_API_KEY is required/);
  });
});

test('fails closed when Copilot auditor credential is missing', async () => {
  await withAuditEnv({ DELIVERY_AUDITOR_PROVIDER: 'copilot', DELIVERY_AUDITOR_MODEL_RESOLVED: 'gpt-5.3-codex', COPILOT_GITHUB_TOKEN: null }, async () => {
    assert.throws(() => new CodexExecutor({
      provider: 'copilot',
      copilotToken: '',
      implementerUser: 'delivery-implementer',
      auditorUser: 'delivery-auditor'
    }), /COPILOT_GITHUB_TOKEN is required/);
  });
});
