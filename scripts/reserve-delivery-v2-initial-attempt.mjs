#!/usr/bin/env node
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createWorkerScopeBinding } from '../.github/scripts/delivery-v2-worker-scope-contract.mjs';
import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { createDispatchDecision } from '../src/v2/dispatch-policy.mjs';
import { executionPolicyFor } from '../src/v2/execution-policy.mjs';
import { createDispatchNonce } from '../src/v2/controller-runtime.mjs';
import { selectTrustedMarkerComment, trustedCommentAuthorForRepository } from '../src/v2/controller-provenance.mjs';

const BOOTSTRAP_MARKER = '<!-- delivery-v2-bootstrap-state -->';
const SHA_RE = /^[0-9a-f]{40}$/i;

function normalizeRecoveryContext(value) {
  if (!value) return null;

  const reason = String(value.reason ?? '').trim();
  const previousImplementationAttempts = Number.parseInt(String(value.previousImplementationAttempts ?? ''), 10);
  const previousControllerHeadSha = String(value.previousControllerHeadSha ?? '').trim().toLowerCase();
  const currentControllerHeadSha = String(value.currentControllerHeadSha ?? '').trim().toLowerCase();

  if (!reason) throw new Error('recovery reason is required');
  if (!Number.isInteger(previousImplementationAttempts) || previousImplementationAttempts < 1) {
    throw new Error('recovery previousImplementationAttempts must be a positive integer');
  }
  if (!SHA_RE.test(previousControllerHeadSha) || !SHA_RE.test(currentControllerHeadSha)) {
    throw new Error('recovery controller SHAs must be exact Git commit SHAs');
  }
  if (previousControllerHeadSha === currentControllerHeadSha) {
    throw new Error('recovery requires a changed control-plane SHA');
  }

  return Object.freeze({
    reason,
    previousImplementationAttempts,
    previousControllerHeadSha,
    currentControllerHeadSha,
    grantedImplementationAttempts: 1
  });
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, label) {
  const result = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function splitPaths(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-initial-attempt-reservation'
  };
}

async function api(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(token), ...(options.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${options.method ?? 'GET'} ${url}: ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function postJson(url, token, body) {
  return api(url, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function encodeRepoPath(value) { return value.split('/').map(encodeURIComponent).join('/'); }

function issuePathCandidates(body) {
  const values = [];
  const text = String(body ?? '');
  for (const match of text.matchAll(/`([^`\n]{1,240})`/g)) values.push(match[1]);
  for (const match of text.matchAll(/(?:^|\s)((?:\.?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@-]+)(?=$|[\s,;:.)])/gm)) values.push(match[1]);
  return [...new Set(values.map((value) => value.replace(/^\.\//, '').trim()).filter((value) => value.includes('/') && !value.includes(' ')))];
}

async function pathExists(repository, ref, filePath, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}/contents/${encodeRepoPath(filePath)}?ref=${encodeURIComponent(ref)}`, { headers: headers(token) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub API ${response.status} while probing ${filePath}`);
  return true;
}

async function deterministicIssuePaths(repository, ref, issueBody, token) {
  const verified = [];
  for (const candidate of issuePathCandidates(issueBody).slice(0, 30)) {
    if (await pathExists(repository, ref, candidate, token)) verified.push(candidate);
  }
  return verified;
}

async function loadRepositoryRiskPolicy(repository) {
  const dir = new URL('../config/delivery-v2-targets/', import.meta.url);
  for (const name of (await readdir(dir)).filter((item) => item.endsWith('.json'))) {
    const config = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
    if (config.repository === repository) return config.riskPolicy ?? {};
  }
  return {};
}

function makePlan({ repository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy }) {
  return createDeliveryPlan(loadV2Config({
    repository,
    issueNumber,
    provider,
    risk: requestedRisk,
    changedPaths,
    riskPolicyJson: JSON.stringify(repositoryPolicy)
  }, {}));
}

export function bootstrapLeaseForDecision({ decision, repository, issueNumber, baseBranch, provider, model = null, requestedRisk, runId, priorImplementationAttempts = 0, workerWorkflow, dispatchNonce = createDispatchNonce(), scopeBinding = null, recovery = null } = {}) {
  if (!decision?.dispatchAllowed) return null;
  const policy = executionPolicyFor(decision.securityProfile);
  const recoveryContext = normalizeRecoveryContext(recovery);
  const nextAttempt = Number(priorImplementationAttempts) + 1;
  if (!Number.isInteger(nextAttempt) || nextAttempt < 1 || nextAttempt > policy.maxImplementationAttempts) throw new Error('initial implementation attempt budget exhausted');
  return Object.freeze({
    schemaVersion: 1,
    repository,
    issueNumber,
    baseBranch,
    provider: String(provider).toLowerCase(),
    model: model == null ? null : String(model),
    requestedRisk: String(requestedRisk).toLowerCase(),
    effectiveRisk: decision.securityProfile,
    implementationAttempts: nextAttempt,
    status: 'reserved-initial-attempt',
    controllerRunId: Number(runId),
    workerRunId: null,
    workerWorkflow: String(workerWorkflow ?? ''),
    dispatchNonce: String(dispatchNonce),
    scopeBinding,
    ...(recoveryContext ? { recovery: recoveryContext } : {})
  });
}

async function main() {
  const repository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  const compatibilityProvider = requiredEnv('DELIVERY_AI_PROVIDER').toLowerCase();
  const requestedRisk = requiredEnv('DELIVERY_RISK_PROFILE').toLowerCase();
  const readToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const writeToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');
  const runId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');
  const priorImplementationAttempts = Number.parseInt(String(process.env.DELIVERY_V2_PRIOR_INITIAL_ATTEMPTS ?? '0'), 10);
  const recoveryReason = String(process.env.DELIVERY_V2_RECOVERY_REASON ?? '').trim();
  const recovery = recoveryReason ? {
    reason: recoveryReason,
    previousImplementationAttempts: Number.parseInt(String(process.env.DELIVERY_V2_RECOVERY_PREVIOUS_ATTEMPTS ?? ''), 10),
    previousControllerHeadSha: String(process.env.DELIVERY_V2_RECOVERY_PREVIOUS_CONTROLLER_SHA ?? '').trim(),
    currentControllerHeadSha: requiredEnv('DELIVERY_V2_RECOVERY_CURRENT_CONTROLLER_SHA')
  } : null;

  const issue = await api(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, readToken);
  const explicitChangedPaths = splitPaths(process.env.DELIVERY_CHANGED_PATHS);
  let changedPaths = explicitChangedPaths;
  if (changedPaths.length === 0) changedPaths = await deterministicIssuePaths(repository, baseBranch, issue.body, readToken);
  const scopeBinding = createWorkerScopeBinding({ repository, issue, authorizedPaths: explicitChangedPaths });
  const repositoryPolicy = await loadRepositoryRiskPolicy(repository);
  const plan = makePlan({ repository, issueNumber, provider: compatibilityProvider, requestedRisk, changedPaths, repositoryPolicy });
  const decision = createDispatchDecision(plan);
  const lease = bootstrapLeaseForDecision({
    decision,
    repository,
    issueNumber,
    baseBranch,
    provider: plan.implementation.provider,
    model: plan.implementation.model,
    requestedRisk,
    runId,
    priorImplementationAttempts,
    workerWorkflow: plan.implementation.workflow,
    scopeBinding,
    recovery
  });

  if (lease) {
    const body = `${BOOTSTRAP_MARKER}\n## Delivery V2 bootstrap state\n\n\`\`\`json\n${JSON.stringify(lease, null, 2)}\n\`\`\``;
    const comments = await api(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100`, readToken);
    const existing = selectTrustedMarkerComment(comments, { marker: BOOTSTRAP_MARKER, label: 'Delivery V2 bootstrap state', trustedLogin: trustedCommentAuthorForRepository(repository) });
    if (existing) await api(`https://api.github.com/repos/${repository}/issues/comments/${existing.id}`, writeToken, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
    else await postJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, writeToken, { body });
  }

  const outputPath = String(process.env.GITHUB_OUTPUT ?? '').trim();
  if (outputPath) {
    await appendFile(outputPath, [
      `reserved=${lease ? 'true' : 'false'}`,
      `attempts=${lease?.implementationAttempts ?? priorImplementationAttempts}`,
      `dispatch_nonce=${lease?.dispatchNonce ?? ''}`,
      `provider=${plan.implementation.provider}`,
      `model=${plan.implementation.model}`
    ].join('\n') + '\n', 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ reserved: Boolean(lease), decision, changedPaths, scopeBinding, implementation: plan.implementation })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
