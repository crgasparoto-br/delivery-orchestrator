#!/usr/bin/env node
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { createDispatchDecision } from '../src/v2/dispatch-policy.mjs';

const BOOTSTRAP_MARKER = '<!-- delivery-v2-bootstrap-state -->';

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

export function bootstrapLeaseForDecision({ decision, repository, issueNumber, baseBranch, provider, requestedRisk, runId } = {}) {
  if (!decision?.dispatchAllowed) return null;
  return Object.freeze({
    schemaVersion: 1,
    repository,
    issueNumber,
    baseBranch,
    provider: String(provider).toLowerCase(),
    requestedRisk: String(requestedRisk).toLowerCase(),
    effectiveRisk: decision.securityProfile,
    implementationAttempts: 1,
    status: 'reserved-initial-attempt',
    controllerRunId: Number(runId)
  });
}

async function main() {
  const repository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  const provider = requiredEnv('DELIVERY_AI_PROVIDER').toLowerCase();
  const requestedRisk = requiredEnv('DELIVERY_RISK_PROFILE').toLowerCase();
  const readToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const writeToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');
  const runId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');

  const issue = await api(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, readToken);
  let changedPaths = splitPaths(process.env.DELIVERY_CHANGED_PATHS);
  if (changedPaths.length === 0) changedPaths = await deterministicIssuePaths(repository, baseBranch, issue.body, readToken);
  const repositoryPolicy = await loadRepositoryRiskPolicy(repository);
  const plan = makePlan({ repository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
  const decision = createDispatchDecision(plan);
  const lease = bootstrapLeaseForDecision({ decision, repository, issueNumber, baseBranch, provider, requestedRisk, runId });

  if (lease) {
    const body = `${BOOTSTRAP_MARKER}\n## Delivery V2 bootstrap state\n\n\`\`\`json\n${JSON.stringify(lease, null, 2)}\n\`\`\``;
    await postJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, writeToken, { body });
  }

  const outputPath = String(process.env.GITHUB_OUTPUT ?? '').trim();
  if (outputPath) await appendFile(outputPath, `reserved=${lease ? 'true' : 'false'}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ reserved: Boolean(lease), decision, changedPaths })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
