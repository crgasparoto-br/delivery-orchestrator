#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { reconcilePersistentState } from '../src/v2/persistent-state.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const BOOTSTRAP_MARKER = '<!-- delivery-v2-bootstrap-state -->';
const SHA_RE = /^[0-9a-f]{40}$/i;

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

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-reentry-guard'
  };
}

async function api(url, token) {
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  return response.json();
}

function closingPattern(issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
}

export function selectManagedPullRequest(pulls, { issueNumber, baseBranch } = {}) {
  if (!Array.isArray(pulls)) throw new Error('pulls must be an array');
  const closing = closingPattern(positiveInteger(issueNumber, 'issueNumber'));
  const base = String(baseBranch ?? '').trim();
  if (!base) throw new Error('baseBranch is required');
  const candidates = pulls.filter((pr) =>
    String(pr?.base?.ref ?? '') === base
    && String(pr?.title ?? '').startsWith('[delivery-v2] ')
    && closing.test(String(pr?.body ?? ''))
  );
  if (candidates.length > 1) throw new Error(`multiple open Delivery V2 PRs found for issue #${issueNumber}`);
  return candidates[0] ?? null;
}

function parseJsonEnvelope(comments, marker, label) {
  if (!Array.isArray(comments)) throw new Error('comments must be an array');
  const matching = comments.filter((comment) => String(comment?.body ?? '').startsWith(marker));
  if (matching.length === 0) return null;
  if (matching.length > 1) throw new Error(`multiple ${label} comments found; refusing ambiguous recovery`);
  const body = String(matching[0].body ?? '');
  const fenced = body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!fenced) throw new Error(`${label} comment is missing its JSON envelope`);
  return Object.freeze({ commentId: matching[0].id ?? null, value: JSON.parse(fenced[1]) });
}

export function parsePersistentStateEnvelope(comments) {
  const parsed = parseJsonEnvelope(comments, STATE_MARKER, 'Delivery V2 state');
  if (!parsed) return null;
  if (!parsed.value?.persistent || typeof parsed.value.persistent !== 'object' || Array.isArray(parsed.value.persistent)) {
    throw new Error('Delivery V2 state comment is missing persistent state');
  }
  return Object.freeze({ commentId: parsed.commentId, persistent: parsed.value.persistent, controller: parsed.value.controller ?? null });
}

export function parseBootstrapLease(comments) {
  const parsed = parseJsonEnvelope(comments, BOOTSTRAP_MARKER, 'Delivery V2 bootstrap state');
  if (!parsed) return null;
  const value = parsed.value;
  return Object.freeze({
    commentId: parsed.commentId,
    schemaVersion: value.schemaVersion,
    repository: String(value.repository ?? ''),
    issueNumber: Number(value.issueNumber),
    baseBranch: String(value.baseBranch ?? ''),
    provider: String(value.provider ?? '').toLowerCase(),
    requestedRisk: String(value.requestedRisk ?? '').toLowerCase(),
    implementationAttempts: Number(value.implementationAttempts),
    status: String(value.status ?? ''),
    controllerRunId: value.controllerRunId == null ? null : Number(value.controllerRunId)
  });
}

export function evaluateReentry({ pullRequest, stateEnvelope, bootstrapLease, targetRepository, issueNumber, baseBranch, provider } = {}) {
  const resolvedIssue = positiveInteger(issueNumber, 'issueNumber');
  const resolvedProvider = String(provider ?? '').toLowerCase();

  if (pullRequest) {
    const prNumber = positiveInteger(pullRequest.number, 'pullRequest.number');
    const remoteHeadSha = String(pullRequest?.head?.sha ?? '').trim().toLowerCase();
    if (!SHA_RE.test(remoteHeadSha)) throw new Error('pullRequest.head.sha must be a 40-character Git commit SHA');

    if (!stateEnvelope) {
      return Object.freeze({
        runController: true,
        resumePr: prNumber,
        status: 'resume-existing-delivery',
        pullRequestNumber: prNumber,
        materialHeadSha: remoteHeadSha,
        staleStateDetected: true,
        nextAction: 'recover-pr-state'
      });
    }

    const persistent = stateEnvelope.persistent;
    if (persistent.issueNumber !== resolvedIssue) throw new Error('persisted state issue does not match requested issue');
    if (String(persistent.baseRef ?? '') !== String(baseBranch ?? '')) throw new Error('persisted state baseRef does not match requested base branch');
    if (String(persistent.provider ?? '').toLowerCase() !== resolvedProvider) throw new Error('persisted state provider does not match requested provider');

    const resumed = reconcilePersistentState(persistent, {
      repository: targetRepository,
      pullRequestNumber: prNumber,
      headRef: String(pullRequest?.head?.ref ?? ''),
      remoteHeadSha
    });
    return Object.freeze({
      runController: true,
      resumePr: prNumber,
      status: 'resume-existing-delivery',
      pullRequestNumber: prNumber,
      materialHeadSha: resumed.state.materialHeadSha,
      staleStateDetected: resumed.staleStateDetected,
      nextAction: resumed.nextAction,
      persistedStatus: resumed.state.status,
      attempts: resumed.state.attempts
    });
  }

  if (bootstrapLease) {
    if (bootstrapLease.repository !== targetRepository || bootstrapLease.issueNumber !== resolvedIssue) throw new Error('bootstrap lease target does not match requested delivery');
    if (bootstrapLease.baseBranch !== String(baseBranch ?? '') || bootstrapLease.provider !== resolvedProvider) throw new Error('bootstrap lease policy does not match requested delivery');
    return Object.freeze({
      runController: false,
      resumePr: null,
      status: 'blocked-initial-attempt-already-reserved',
      pullRequestNumber: null,
      materialHeadSha: null,
      staleStateDetected: false,
      nextAction: 'recover-initial-attempt',
      attempts: { implementation: bootstrapLease.implementationAttempts }
    });
  }

  return Object.freeze({
    runController: true,
    resumePr: null,
    status: 'new-delivery',
    pullRequestNumber: null,
    materialHeadSha: null,
    staleStateDetected: false,
    nextAction: 'dispatch-initial-worker',
    attempts: { implementation: 0 }
  });
}

async function listOpenPullRequests(repository, baseBranch, token) {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`https://api.github.com/repos/${repository}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100&page=${page}`, token);
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return pulls;
}

async function listIssueComments(repository, issueNumber, token) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`, token);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function writeGithubOutput(decision) {
  const outputPath = String(process.env.GITHUB_OUTPUT ?? '').trim();
  if (!outputPath) return;
  const lines = [
    `run_controller=${decision.runController ? 'true' : 'false'}`,
    `resume_pr=${decision.resumePr ?? ''}`,
    `status=${decision.status}`,
    `pr_number=${decision.pullRequestNumber ?? ''}`,
    `next_action=${decision.nextAction}`
  ].join('\n');
  await appendFile(outputPath, `${lines}\n`, 'utf8');
}

async function main() {
  const targetRepository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  const provider = requiredEnv('DELIVERY_AI_PROVIDER');
  const readToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const resultPath = String(process.env.CONTROLLER_RESULT_PATH ?? '').trim();

  const pulls = await listOpenPullRequests(targetRepository, baseBranch, readToken);
  const pullRequest = selectManagedPullRequest(pulls, { issueNumber, baseBranch });
  let stateEnvelope = null;
  let bootstrapLease = null;
  if (pullRequest) stateEnvelope = parsePersistentStateEnvelope(await listIssueComments(targetRepository, pullRequest.number, readToken));
  else bootstrapLease = parseBootstrapLease(await listIssueComments(targetRepository, issueNumber, readToken));

  const decision = evaluateReentry({ pullRequest, stateEnvelope, bootstrapLease, targetRepository, issueNumber, baseBranch, provider });
  await writeGithubOutput(decision);

  if (!decision.runController && resultPath) {
    const payload = {
      schemaVersion: 1,
      status: decision.status,
      repository: targetRepository,
      issueNumber,
      pullRequestNumber: decision.pullRequestNumber,
      materialHeadSha: decision.materialHeadSha,
      providerCalls: 0,
      reentry: {
        staleStateDetected: decision.staleStateDetected,
        persistedStatus: decision.persistedStatus ?? null,
        nextAction: decision.nextAction,
        attempts: decision.attempts ?? null
      }
    };
    await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
