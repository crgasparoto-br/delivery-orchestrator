import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertFrozenAuditIdentity,
  bindAuditRuntimeIdentity,
  controllerAuditIdentityFromEnvelope,
  resolveConfiguredAuditIdentity
} from '../scripts/validate-delivery-v2-audit-ai-identity.mjs';

const SHA = 'a'.repeat(40);

function controllerEnvelope(overrides = {}) {
  return {
    persistent: {
      repository: 'owner/repo',
      issueNumber: 76,
      pullRequestNumber: 77,
      materialHeadSha: SHA,
      effectiveRisk: 'critical',
      auditorProvider: 'codex',
      auditorModel: 'gpt-5.6-sol',
      ...overrides.persistent
    },
    controller: {
      auditDispatchNonce: 'audit-nonce-1',
      ...overrides.controller
    }
  };
}

const target = Object.freeze({
  repository: 'owner/repo',
  issueNumber: 76,
  pullRequestNumber: 77,
  candidateSha: SHA,
  riskProfile: 'critical',
  dispatchNonce: 'audit-nonce-1'
});

test('resolves the current audit identity from risk-specific variables', () => {
  const identity = resolveConfiguredAuditIdentity({
    AUDIT_RISK_PROFILE: 'critical',
    DELIVERY_AUDITOR_PROVIDER_GENERAL: 'codex',
    DELIVERY_AUDITOR_MODEL_GENERAL: 'general-model',
    DELIVERY_CRITICAL_AUDITOR_PROVIDER_CONFIG: 'claude',
    DELIVERY_CRITICAL_AUDITOR_MODEL_CONFIG: 'claude-opus-5'
  });
  assert.deepEqual(identity, { provider: 'claude', model: 'claude-opus-5', risk: 'critical' });
});

test('controller state freezes the audit identity for the exact PR head and dispatch nonce', () => {
  assert.deepEqual(controllerAuditIdentityFromEnvelope(controllerEnvelope(), target), {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    risk: 'critical'
  });
  assert.throws(() => controllerAuditIdentityFromEnvelope(controllerEnvelope({ controller: { auditDispatchNonce: 'other' } }), target), /dispatch nonce mismatch/);
  assert.throws(() => controllerAuditIdentityFromEnvelope(controllerEnvelope({ persistent: { materialHeadSha: 'b'.repeat(40) } }), target), /candidate mismatch/);
});

test('audit provider drift is rejected before provider invocation', () => {
  const expected = controllerAuditIdentityFromEnvelope(controllerEnvelope(), target);
  assert.throws(() => assertFrozenAuditIdentity(expected, {
    provider: 'claude',
    model: 'claude-opus-5',
    risk: 'critical'
  }), /audit provider drift detected/);
});

test('audit model drift is rejected before provider invocation', () => {
  const expected = controllerAuditIdentityFromEnvelope(controllerEnvelope(), target);
  assert.throws(() => assertFrozenAuditIdentity(expected, {
    provider: 'codex',
    model: 'gpt-5.6-sol-preview',
    risk: 'critical'
  }), /audit model drift detected/);
});

test('effective audit runtime identity is retained inside the authoritative result consumed by the controller', () => {
  const payload = { providerCalls: 1, result: { decision: 'approved', findings: [] } };
  const result = bindAuditRuntimeIdentity(payload, {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    risk: 'critical',
    invoked: true
  });
  assert.deepEqual(result.auditRuntime, result.result.auditRuntime);
  assert.deepEqual(result.result.auditRuntime, {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    risk: 'critical',
    invoked: true
  });
});

test('audit workflow validates frozen identity before invoking the provider and binds it into result', async () => {
  const source = await readFile(new URL('../.github/workflows/delivery-v2-audit.yml', import.meta.url), 'utf8');
  const validateAt = source.indexOf('Validate frozen audit AI identity');
  const invokeAt = source.indexOf('Run exact-head GitHub-native audit');
  assert.ok(validateAt >= 0 && invokeAt > validateAt, 'identity gate must execute before audit provider invocation');
  assert.match(source, /validate-delivery-v2-audit-ai-identity\.mjs validate/);
  assert.match(source, /validate-delivery-v2-audit-ai-identity\.mjs bind-result/);
});
