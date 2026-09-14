#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseTrustedJsonEnvelope, trustedCommentAuthorForRepository } from '../src/v2/controller-provenance.mjs';
import { resolveProviderSelectionForRisk } from '../src/v2/provider-policy.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const SHA_RE = /^[0-9a-f]{40}$/i;
const MODEL_RE = /^[A-Za-z0-9._:/?=&+~-]+$/;

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function requiredSha(value, label) {
  const result = requiredString(value, label).toLowerCase();
  if (!SHA_RE.test(result)) throw new Error(`${label} must be a 40-character Git SHA`);
  return result;
}

function auditPolicyFromEnv(env) {
  return {
    auditorProvider: env.DELIVERY_AUDITOR_PROVIDER_GENERAL ?? env.DELIVERY_AUDITOR_PROVIDER,
    auditorModel: env.DELIVERY_AUDITOR_MODEL_GENERAL ?? env.DELIVERY_AUDITOR_MODEL,
    standardAuditorProvider: env.DELIVERY_STANDARD_AUDITOR_PROVIDER_CONFIG ?? env.DELIVERY_STANDARD_AUDITOR_PROVIDER,
    standardAuditorModel: env.DELIVERY_STANDARD_AUDITOR_MODEL_CONFIG ?? env.DELIVERY_STANDARD_AUDITOR_MODEL,
    criticalAuditorProvider: env.DELIVERY_CRITICAL_AUDITOR_PROVIDER_CONFIG ?? env.DELIVERY_CRITICAL_AUDITOR_PROVIDER,
    criticalAuditorModel: env.DELIVERY_CRITICAL_AUDITOR_MODEL_CONFIG ?? env.DELIVERY_CRITICAL_AUDITOR_MODEL
  };
}

export function resolveConfiguredAuditIdentity(env = process.env) {
  const risk = requiredString(env.AUDIT_RISK_PROFILE, 'AUDIT_RISK_PROFILE').toLowerCase();
  if (!['standard', 'critical'].includes(risk)) throw new Error('AUDIT_RISK_PROFILE must be standard or critical');
  const selection = resolveProviderSelectionForRisk(auditPolicyFromEnv(env), risk).auditor;
  if (!MODEL_RE.test(selection.model)) throw new Error('Configured auditor model contains unsupported characters');
  return Object.freeze({ provider: selection.provider, model: selection.model, risk });
}

export function controllerAuditIdentityFromEnvelope(envelope, {
  repository,
  issueNumber,
  pullRequestNumber,
  candidateSha,
  riskProfile,
  dispatchNonce
} = {}) {
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') throw new Error('controller state envelope is required');
  const persistent = envelope.persistent;
  const controller = envelope.controller;
  if (!persistent || Array.isArray(persistent) || typeof persistent !== 'object') throw new Error('controller persistent state is required');
  if (!controller || Array.isArray(controller) || typeof controller !== 'object') throw new Error('controller runtime state is required');
  const expectedRepository = requiredString(repository, 'repository');
  const expectedIssue = requiredPositiveInteger(issueNumber, 'issueNumber');
  const expectedPr = requiredPositiveInteger(pullRequestNumber, 'pullRequestNumber');
  const expectedSha = requiredSha(candidateSha, 'candidateSha');
  const expectedRisk = requiredString(riskProfile, 'riskProfile').toLowerCase();
  const expectedNonce = requiredString(dispatchNonce, 'dispatchNonce');
  if (String(persistent.repository ?? '') !== expectedRepository) throw new Error('controller audit repository mismatch');
  if (Number(persistent.issueNumber) !== expectedIssue) throw new Error('controller audit issue mismatch');
  if (Number(persistent.pullRequestNumber) !== expectedPr) throw new Error('controller audit PR mismatch');
  if (requiredSha(persistent.materialHeadSha, 'persistent.materialHeadSha') !== expectedSha) throw new Error('controller audit candidate mismatch');
  if (String(persistent.effectiveRisk ?? '').toLowerCase() !== expectedRisk) throw new Error('controller audit risk mismatch');
  if (String(controller.auditDispatchNonce ?? '') !== expectedNonce) throw new Error('controller audit dispatch nonce mismatch');
  const provider = requiredString(persistent.auditorProvider, 'persistent.auditorProvider').toLowerCase();
  const model = requiredString(persistent.auditorModel, 'persistent.auditorModel');
  return Object.freeze({ provider, model, risk: expectedRisk });
}

export function assertFrozenAuditIdentity(expected, actual) {
  if (expected.risk !== actual.risk) throw new Error(`audit risk drift detected: controller=${expected.risk} workflow=${actual.risk}`);
  if (expected.provider !== actual.provider) throw new Error(`audit provider drift detected: controller=${expected.provider} workflow=${actual.provider}`);
  if (expected.model !== actual.model) throw new Error(`audit model drift detected: controller=${expected.model} workflow=${actual.model}`);
  return true;
}

export function bindAuditRuntimeIdentity(payload, identity) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('audit result payload must be an object');
  if (!payload.result || Array.isArray(payload.result) || typeof payload.result !== 'object') throw new Error('audit result payload.result must be an object');
  const runtime = Object.freeze({
    provider: requiredString(identity.provider, 'auditRuntime.provider').toLowerCase(),
    model: requiredString(identity.model, 'auditRuntime.model'),
    risk: requiredString(identity.risk, 'auditRuntime.risk').toLowerCase(),
    invoked: identity.invoked === true
  });
  payload.auditRuntime = runtime;
  payload.result.auditRuntime = runtime;
  return payload;
}

function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requiredString(token, 'DELIVERY_GITHUB_READ_TOKEN')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-audit-ai-identity'
  };
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  return response.json();
}

async function validateBeforeInvocation(env = process.env) {
  const repository = requiredString(env.TARGET_REPOSITORY, 'TARGET_REPOSITORY');
  const issueNumber = requiredPositiveInteger(env.TARGET_ISSUE, 'TARGET_ISSUE');
  const pullRequestNumber = requiredPositiveInteger(env.TARGET_PR, 'TARGET_PR');
  const dispatchNonce = requiredString(env.AUDIT_DISPATCH_NONCE, 'AUDIT_DISPATCH_NONCE');
  const token = requiredString(env.DELIVERY_GITHUB_READ_TOKEN, 'DELIVERY_GITHUB_READ_TOKEN');
  const actual = resolveConfiguredAuditIdentity(env);
  const [pullRequest, comments] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`, token),
    fetchJson(`https://api.github.com/repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`, token)
  ]);
  const candidateSha = requiredSha(pullRequest.head?.sha, 'pullRequest.head.sha');
  const trusted = parseTrustedJsonEnvelope(comments, {
    marker: STATE_MARKER,
    label: 'Delivery V2 state',
    trustedLogin: trustedCommentAuthorForRepository(repository)
  });
  if (!trusted) throw new Error('authoritative Delivery V2 state comment is missing');
  const expected = controllerAuditIdentityFromEnvelope(trusted.value, {
    repository,
    issueNumber,
    pullRequestNumber,
    candidateSha,
    riskProfile: actual.risk,
    dispatchNonce
  });
  assertFrozenAuditIdentity(expected, actual);
  const envPath = requiredString(env.GITHUB_ENV, 'GITHUB_ENV');
  await appendFile(envPath, [
    `DELIVERY_AUDITOR_PROVIDER=${expected.provider}`,
    `DELIVERY_AUDITOR_MODEL_RESOLVED=${expected.model}`,
    `OPENAI_MODEL=${expected.model}`,
    `DELIVERY_EXPECTED_AUDITOR_PROVIDER=${expected.provider}`,
    `DELIVERY_EXPECTED_AUDITOR_MODEL=${expected.model}`
  ].join('\n') + '\n', 'utf8');
  process.stdout.write(`${JSON.stringify({ validated: true, candidateSha, ...expected })}\n`);
}

async function bindResult(env = process.env) {
  const resultPath = requiredString(env.AUDIT_RESULT_PATH, 'AUDIT_RESULT_PATH');
  const payload = JSON.parse(await readFile(resultPath, 'utf8'));
  const identity = {
    provider: requiredString(env.DELIVERY_AUDITOR_PROVIDER, 'DELIVERY_AUDITOR_PROVIDER'),
    model: requiredString(env.DELIVERY_AUDITOR_MODEL_RESOLVED, 'DELIVERY_AUDITOR_MODEL_RESOLVED'),
    risk: requiredString(env.AUDIT_RISK_PROFILE, 'AUDIT_RISK_PROFILE'),
    invoked: Number(payload.providerCalls || 0) > 0
  };
  bindAuditRuntimeIdentity(payload, identity);
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] || 'validate';
  if (command === 'validate') return validateBeforeInvocation(env);
  if (command === 'bind-result') return bindResult(env);
  throw new Error(`Unsupported audit AI identity command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
