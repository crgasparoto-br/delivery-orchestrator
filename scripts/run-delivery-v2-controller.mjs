#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { createDispatchDecision } from '../src/v2/dispatch-policy.mjs';
import {
  applyOperationalEvent,
  createOperationalDelivery,
  evaluateOperationalRelease,
  operationalRemediationInput,
  persistentStateFromOperational
} from '../src/v2/operational-controller.mjs';
import { normalizeGhAwUsage, parseGhAwUsageJsonl } from '../src/v2/usage-telemetry.mjs';
import { downloadGhAwTechnicalHygieneArtifact } from '../src/v2/gh-aw-hygiene-artifact.mjs';
import { ciFailureClassForEvidence, collectCiFailureEvidence, collectMergePreviewEvidence, createDispatchNonce, loadAuthoritativeAuditResult, publishReleaseStatus, releaseIdentityFromPullRequest, selectCorrelatedWorkflowRun } from '../src/v2/controller-runtime.mjs';
import { selectAuthoritativeSourceWorkflowRun, selectCheckForWorkflowRun } from '../src/v2/ci-evidence-correlation.mjs';
import { selectTrustedMarkerComment, trustedCommentAuthorForRepository } from '../src/v2/controller-provenance.mjs';
import { normalizeControllerTargetPolicy } from '../src/v2/controller-target-policy.mjs';
import { withTransientFetchRetry } from '../src/v2/github-api-retry.mjs';
import {
  createControllerDeliveryMetrics,
  createControllerObservability,
  createControllerPartialMetrics,
  recordControllerAuditWorkflowFailure,
  recordControllerCiObservation,
  recordControllerProviderObservation,
  runDurationMs
} from '../src/v2/controller-observability.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const SHA_RE = /^[0-9a-f]{40}$/i;
const RISK_RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });
const POLL_MS = Number(process.env.DELIVERY_V2_POLL_MS || 10000);
const MAX_STAGE_MS = Number(process.env.DELIVERY_V2_STAGE_TIMEOUT_MS || 75 * 60 * 1000);

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function positiveInteger(value, label) {
  const result = Number(String(value ?? '').trim());
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}
export function nonNegativeInteger(value, label) {
  const normalized = String(value ?? '').trim();
  const result = Number(normalized);
  if (!normalized || !Number.isInteger(result) || result < 0) throw new Error(`${label} must be a non-negative integer`);
  return result;
}
function splitPaths(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function headers(token, accept = 'application/vnd.github+json') {
  return { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'delivery-v2-controller' };
}
async function api(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(token, options.accept), ...(options.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${options.method ?? 'GET'} ${url}: ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function postJson(url, token, body) {
  return api(url, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function patchJson(url, token, body) {
  return api(url, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function encodeRepoPath(value) { return value.split('/').map(encodeURIComponent).join('/'); }

async function loadControllerTarget(repository, baseBranch) {
  const config = JSON.parse(await readFile(new URL('../config/delivery-v2-controller-targets.json', import.meta.url), 'utf8'));
  const target = config.targets?.[repository];
  if (!target) throw new Error(`repository is not configured for Delivery V2 controller: ${repository}`);
  return normalizeControllerTargetPolicy(repository, target, { baseBranch });
}

async function loadRepositoryRiskPolicy(repository) {
  const dir = new URL('../config/delivery-v2-targets/', import.meta.url);
  for (const name of (await readdir(dir)).filter((item) => item.endsWith('.json'))) {
    const config = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
    if (config.repository === repository) return config.riskPolicy ?? {};
  }
  return {};
}

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
  const candidates = issuePathCandidates(issueBody).slice(0, 30);
  const verified = [];
  for (const candidate of candidates) if (await pathExists(repository, ref, candidate, token)) verified.push(candidate);
  return verified;
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

async function listWorkflowRuns(repository, workflow, token) {
  const payload = await api(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=30`, token);
  return payload.workflow_runs ?? [];
}

async function dispatchWorkflowAndResolveRun({ repository, workflow, ref, inputs, token, kind, dispatchNonce = createDispatchNonce() }) {
  await postJson(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, token, { ref, inputs: { ...inputs, dispatch_nonce: dispatchNonce } });
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const correlated = selectCorrelatedWorkflowRun(await listWorkflowRuns(repository, workflow, token), { kind, nonce: dispatchNonce, ref });
    if (correlated) return correlated;
    await sleep(Math.min(POLL_MS, 5000));
  }
  throw new Error(`timed out resolving correlated workflow dispatch: ${workflow}`);
}

async function waitWorkflowRun(repository, runId, token) {
  const deadline = Date.now() + MAX_STAGE_MS;
  while (Date.now() < deadline) {
    const run = await api(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, token);
    if (run.status === 'completed') return run;
    await sleep(POLL_MS);
  }
  throw new Error(`workflow run ${runId} exceeded bounded stage timeout`);
}

async function findManagedPullRequest({ repository, issueNumber, baseBranch, since, token }) {
  const deadline = Date.now() + 12 * 60 * 1000;
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
  while (Date.now() < deadline) {
    const pulls = await withTransientFetchRetry(
      () => api(`https://api.github.com/repos/${repository}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100`, token),
      { label: `findManagedPullRequest(${repository}#${issueNumber})` }
    );
    const trustedLogin = trustedCommentAuthorForRepository(repository);
    const candidates = pulls.filter((pr) => Date.parse(pr.created_at) >= since - 5000 && String(pr.title ?? '').startsWith('[delivery-v2] ') && closing.test(String(pr.body ?? '')) && String(pr.user?.login ?? '').toLowerCase() === trustedLogin && String(pr.head?.repo?.full_name ?? repository) === repository);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw new Error(`multiple Delivery V2 PRs found for issue #${issueNumber}`);
    await sleep(POLL_MS);
  }
  throw new Error(`worker completed but no managed PR was found for issue #${issueNumber}`);
}

async function fetchPullRequest(repository, prNumber, token) {
  return api(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, token);
}

async function fetchChangedPaths(repository, prNumber, token) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const files = await api(`https://api.github.com/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`, token);
    result.push(...files.map((file) => file.filename));
    if (files.length < 100) break;
  }
  if (result.length === 0) throw new Error('managed PR has no changed paths');
  return result;
}

async function classifierIdentity(repository, ref, token) {
  try {
    const payload = await api(`https://api.github.com/repos/${repository}/contents/.delivery-v2/lock.json?ref=${encodeURIComponent(ref)}`, token);
    const lock = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
    const fingerprint = String(lock.canonicalClassifierFingerprint ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('invalid canonicalClassifierFingerprint');
    return { version: `${lock.source?.repository ?? 'unknown'}@${lock.source?.commit ?? 'unknown'}`, fingerprint, evidenceRef: payload.html_url };
  } catch (error) {
    if (repository !== process.env.GITHUB_REPOSITORY) throw error;
    const payload = await api(`https://api.github.com/repos/${repository}/contents/src/v2/risk-profile.mjs?ref=${encodeURIComponent(ref)}`, token);
    const content = Buffer.from(payload.content, 'base64');
    return { version: 'delivery-v2-risk-profile-v1', fingerprint: createHash('sha256').update(content).digest('hex'), evidenceRef: payload.html_url };
  }
}

async function fetchCheckRuns(repository, sha, token) {
  const payload = await api(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`, token);
  return payload.check_runs ?? [];
}

async function sourceWorkflowRunForHead({ repository, sha, workflowName, token }) {
  const payload = await api(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`, token);
  return selectAuthoritativeSourceWorkflowRun(payload.workflow_runs ?? [], { workflowName, sha });
}

async function waitRequiredCheck({ repository, prNumber, sha, requiredStatusName, workflowName, token }) {
  const deadline = Date.now() + MAX_STAGE_MS;
  while (Date.now() < deadline) {
    const pr = await fetchPullRequest(repository, prNumber, token);
    const current = String(pr.head.sha).toLowerCase();
    if (current !== sha.toLowerCase()) return { kind: 'head-drift', pullRequest: pr };
    const sourceRun = await sourceWorkflowRunForHead({ repository, sha, workflowName, token });
    if (!sourceRun) { await sleep(POLL_MS); continue; }
    const check = selectCheckForWorkflowRun(await fetchCheckRuns(repository, sha, token), { requiredStatusName, workflowRunId: sourceRun.id });
    if (sourceRun.status === 'completed' && check?.status === 'completed') return { kind: 'check', check, sourceRun, pullRequest: pr };
    if (sourceRun.status === 'completed' && !check) throw new Error(`required check ${requiredStatusName} is missing for authoritative workflow run ${sourceRun.id}`);
    await sleep(POLL_MS);
  }
  throw new Error(`required check ${requiredStatusName} did not become terminal within bounded timeout`);
}

async function upsertStateComment({ repository, prNumber, state, identity, classifier, workflowChecks, evidenceRefs, token, extra = {} }) {
  const persistent = persistentStateFromOperational({ state, identity, classifier, workflowChecks, evidenceRefs });
  const body = `${STATE_MARKER}\n## Delivery V2 controller state\n\n\`\`\`json\n${JSON.stringify({ persistent, controller: extra }, null, 2)}\n\`\`\``;
  const comments = await api(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments?per_page=100`, token);
  const existing = selectTrustedMarkerComment(comments, { marker: STATE_MARKER, label: 'Delivery V2 state', trustedLogin: trustedCommentAuthorForRepository(repository) });
  if (existing) await patchJson(`https://api.github.com/repos/${repository}/issues/comments/${existing.id}`, token, { body });
  else await postJson(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments`, token, { body });
  return persistent;
}

async function postScopeRequired({ repository, issueNumber, token }) {
  const body = '<!-- delivery-v2-scope-required -->\n## Delivery V2 scope discovery\n\nNo concrete repository path could be derived deterministically from this issue. The security profile remains fail-closed CRITICAL, but **no AI implementation call was made**. Re-run Delivery V2 Dispatch with `changed_paths` containing the smallest expected file/path envelope.';
  await postJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, token, { body });
}

async function dispatchWorker({ orchestratorRepository, orchestratorRef, plan, controllerRunId, targetRepository, issueNumber, baseBranch, targetRef, targetPr = '', remediationContext = '', token, dispatchNonce = createDispatchNonce() }) {
  return dispatchWorkflowAndResolveRun({
    repository: orchestratorRepository,
    workflow: plan.implementation.workflow,
    ref: orchestratorRef,
    token,
    kind: 'worker',
    dispatchNonce,
    inputs: {
      controller_run_id: String(controllerRunId),
      target_repository: targetRepository,
      target_issue: String(issueNumber),
      base_branch: baseBranch,
      target_ref: targetRef,
      target_pr: targetPr ? String(targetPr) : '',
      remediation_context: remediationContext
    }
  });
}

async function auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber, candidateSha, auditRun, sourceWorkflowRunId, token }) {
  return loadAuthoritativeAuditResult({ orchestratorRepository, trustedRef: orchestratorRef, targetRepository, issueNumber, pullRequestNumber: prNumber, candidateSha, auditRun, sourceWorkflowRunId, token });
}

async function downloadWorkerUsage(orchestratorRepository, runId, token) {
  try {
    const payload = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${runId}/artifacts?per_page=100`, token);
    const artifact = (payload.artifacts ?? []).find((item) => item.name === 'usage');
    if (!artifact) return { usage: normalizeGhAwUsage({}), evidenceRef: null };
    const response = await fetch(`https://api.github.com/repos/${orchestratorRepository}/actions/artifacts/${artifact.id}/zip`, { headers: headers(token) });
    if (!response.ok) throw new Error(`usage artifact download failed: ${response.status}`);
    const root = await mkdtemp(path.join(tmpdir(), 'dv2-usage-'));
    try {
      const zip = path.join(root, 'usage.zip');
      await writeFile(zip, Buffer.from(await response.arrayBuffer()));
      execFileSync('unzip', ['-q', zip, '-d', root]);
      const stack = [root];
      let json = null;
      let jsonl = null;
      while (stack.length) {
        const current = stack.pop();
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name === 'agent_usage.json') json = full;
          else if (entry.name === 'agent_usage.jsonl') jsonl = full;
        }
      }
      let usage = normalizeGhAwUsage({});
      if (json) usage = normalizeGhAwUsage(JSON.parse(await readFile(json, 'utf8')));
      else if (jsonl) usage = parseGhAwUsageJsonl(await readFile(jsonl, 'utf8'));
      return { usage, evidenceRef: artifact.archive_download_url, artifactId: artifact.id };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } catch (error) {
    return { usage: normalizeGhAwUsage({}), evidenceRef: null, error: error.message };
  }
}

function checkEvidence(check, sourceRun, sha) {
  return [{
    name: check.name,
    subjectSha: sha,
    status: check.status,
    conclusion: check.conclusion,
    workflowRunId: sourceRun?.id ?? null,
    evidenceRef: check.details_url ?? sourceRun?.html_url ?? `github:${sha}`
  }];
}

async function waitHeadChange(repository, prNumber, previousSha, token) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const pr = await fetchPullRequest(repository, prNumber, token);
    if (String(pr.head.sha).toLowerCase() !== previousSha.toLowerCase()) return pr;
    await sleep(POLL_MS);
  }
  throw new Error('remediation worker completed without publishing a new material head');
}

function higherRisk(next, current) {
  return RISK_RANK[next] > RISK_RANK[current];
}

async function ensurePromotedTechnicalHygiene({ hygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber, materialHeadSha, baselineSha, previousMaterialSha = null, actionsToken, targetReadToken, authorizePromotion }) {
  if (!hygiene?.promotionRequired) return { hygiene, state, plan, promotionRun: null };
  const promotedPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk: 'standard', changedPaths, repositoryPolicy });
  let promotedState = applyOperationalEvent(state, { type: 'promote-risk', plan: promotedPlan });
  const dispatchNonce = createDispatchNonce();
  if (typeof authorizePromotion !== 'function') {
    throw new Error('technical hygiene promotion authorization publisher is required');
  }
  await authorizePromotion({
    phase: 'dispatch',
    dispatchNonce,
    runId: null,
    promotedState
  });
  let promotionRun = await dispatchWorker({
    orchestratorRepository,
    orchestratorRef,
    plan: promotedPlan,
    controllerRunId,
    targetRepository,
    issueNumber,
    baseBranch,
    targetRef: materialHeadSha,
    targetPr: pullRequestNumber,
    remediationContext: JSON.stringify({ kind: 'technical-hygiene-evidence-promotion', evidenceOnly: true, materialSha: materialHeadSha, missingEvidence: hygiene.missingEvidence }),
    token: actionsToken,
    dispatchNonce
  });
  await authorizePromotion({
    phase: 'observe',
    dispatchNonce,
    runId: promotionRun.id,
    promotedState
  });
  promotionRun = await waitWorkflowRun(orchestratorRepository, promotionRun.id, actionsToken);
  if (promotionRun.conclusion !== 'success') throw new Error(`technical hygiene STANDARD promotion worker failed: ${promotionRun.html_url}`);
  const currentPr = await fetchPullRequest(targetRepository, pullRequestNumber, targetReadToken);
  if (String(currentPr.head.sha).toLowerCase() !== materialHeadSha.toLowerCase()) throw new Error('technical hygiene evidence-only promotion mutated the material head');
  const reevaluated = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: promotionRun.id, token: actionsToken, baselineSha, materialSha: materialHeadSha, previousMaterialSha, profile: promotedState.riskProfile });
  promotedState = applyOperationalEvent(promotedState, { type: 'technical-hygiene-result', result: reevaluated });
  return { hygiene: reevaluated, state: promotedState, plan: promotedPlan, promotionRun };
}

export async function main() {
  if (String(process.env.DELIVERY_V2_RESUME_PR ?? '').trim()) {
    const { main: resumeMain } = await import('./resume-delivery-v2-controller.mjs');
    return resumeMain();
  }
  const startedAt = Date.now();
  const targetRepository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  const provider = requiredEnv('DELIVERY_AI_PROVIDER').toLowerCase();
  const requestedRisk = requiredEnv('DELIVERY_RISK_PROFILE').toLowerCase();
  const orchestratorRepository = requiredEnv('GITHUB_REPOSITORY');
  const orchestratorRef = requiredEnv('ORCHESTRATOR_WORKER_REF');
  const targetReadToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const targetWriteToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');
  const actionsToken = requiredEnv('GITHUB_TOKEN');
  const controllerRunId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');
  const resultPath = process.env.CONTROLLER_RESULT_PATH || path.join(process.env.RUNNER_TEMP || tmpdir(), 'delivery-v2-controller-result.json');
  const initialAttempts = nonNegativeInteger(process.env.DELIVERY_V2_INITIAL_ATTEMPTS || '1', 'DELIVERY_V2_INITIAL_ATTEMPTS');
  const recoverWorkerRunId = String(process.env.DELIVERY_V2_RECOVER_WORKER_RUN_ID ?? '').trim() ? positiveInteger(process.env.DELIVERY_V2_RECOVER_WORKER_RUN_ID, 'DELIVERY_V2_RECOVER_WORKER_RUN_ID') : null;
  const initialDispatchNonce = String(process.env.DELIVERY_V2_INITIAL_DISPATCH_NONCE ?? '').trim() || createDispatchNonce();
  const targetPolicy = await loadControllerTarget(targetRepository, baseBranch);
  const repositoryPolicy = await loadRepositoryRiskPolicy(targetRepository);
  const issue = await api(`https://api.github.com/repos/${targetRepository}/issues/${issueNumber}`, targetReadToken);
  let changedPaths = splitPaths(process.env.DELIVERY_CHANGED_PATHS);
  if (changedPaths.length === 0) changedPaths = await deterministicIssuePaths(targetRepository, baseBranch, issue.body, targetReadToken);
  let plan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
  const dispatchDecision = createDispatchDecision(plan);
  const initialWorkerIdentity = plan.implementation.workflow;
  const initialWorkerProvider = plan.implementation.provider;

  if (!dispatchDecision.dispatchAllowed) {
    await postScopeRequired({ repository: targetRepository, issueNumber, token: targetWriteToken });
    const payload = { schemaVersion: 1, status: 'needs-scope', targetRepository, issueNumber, dispatchDecision, changedPaths, providerCalls: 0 };
    await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const workerRuns = [];
  const auditRuns = [];
  const evidenceRefs = [];
  let initialDispatchAt = Date.now();
  let worker;
  if (recoverWorkerRunId) {
    worker = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${recoverWorkerRunId}`, actionsToken);
    initialDispatchAt = Date.parse(worker.created_at ?? worker.run_started_at ?? new Date().toISOString());
  } else {
    worker = await dispatchWorker({ orchestratorRepository, orchestratorRef, plan, controllerRunId, targetRepository, issueNumber, baseBranch, targetRef: baseBranch, token: actionsToken, dispatchNonce: initialDispatchNonce });
  }
  worker = await waitWorkflowRun(orchestratorRepository, worker.id, actionsToken);
  workerRuns.push(worker);
  const workerUsage = await downloadWorkerUsage(orchestratorRepository, worker.id, actionsToken);
  let observability = recordControllerProviderObservation(createControllerObservability({ startedAtMs: startedAt }), {
    runId: worker.id,
    stage: 'implementation',
    usage: workerUsage.usage,
    evidenceRef: workerUsage.evidenceRef ?? worker.html_url
  });
  if (workerUsage.evidenceRef) evidenceRefs.push(workerUsage.evidenceRef);
  if (worker.conclusion !== 'success') throw new Error(`initial implementation worker failed: ${worker.html_url}`);

  let pullRequest = await findManagedPullRequest({ repository: targetRepository, issueNumber, baseBranch, since: initialDispatchAt, token: targetReadToken });
  let materialHeadSha = String(pullRequest.head.sha).toLowerCase();
  const expectedBaseSha = String(pullRequest.base.sha).toLowerCase();
  changedPaths = await fetchChangedPaths(targetRepository, pullRequest.number, targetReadToken);
  plan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
  let state = createOperationalDelivery({ plan, materialHeadSha });
  state = Object.freeze({ ...state, implementationAttempts: Math.max(state.implementationAttempts, initialAttempts) });
  let classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
  let latestCheck = null;
  let latestSourceRun = null;
  let lastAudit = null;
  let controller = { controllerRunId, controllerRepository: orchestratorRepository, controllerRef: orchestratorRef, controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml', observability };
  const identity = () => ({
    issueNumber,
    pullRequestNumber: pullRequest.number,
    baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
    headRef: pullRequest.head.ref,
    provider
  });
  const persist = async (extra = {}, stateOverride = state) => {
    controller = { ...controller, observability, ...extra };
    return upsertStateComment({ repository: targetRepository, prNumber: pullRequest.number, state: stateOverride, identity: identity(), classifier, workflowChecks: latestCheck && latestSourceRun ? checkEvidence(latestCheck, latestSourceRun, materialHeadSha) : [], evidenceRefs, token: targetWriteToken, extra: controller });
  };

  let initialTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: null, profile: state.riskProfile });
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: initialTechnicalHygiene });
  evidenceRefs.push(initialTechnicalHygiene.evidenceRef);
  const initialPromotion = await ensurePromotedTechnicalHygiene({ hygiene: initialTechnicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: pullRequest.number, materialHeadSha, baselineSha: expectedBaseSha, actionsToken, targetReadToken, authorizePromotion: async ({ phase, dispatchNonce, runId, promotedState }) => {
        await persist({
          nextAction: phase === 'observe'
            ? 'observe-technical-hygiene'
            : 'dispatch-technical-hygiene',
          hygieneDispatchNonce: dispatchNonce,
          hygieneRunId: runId
        }, promotedState);
      } });
  if (initialPromotion.promotionRun) {
    state = initialPromotion.state;
    plan = initialPromotion.plan;
    initialTechnicalHygiene = initialPromotion.hygiene;
    workerRuns.push(initialPromotion.promotionRun);
    const promotionUsage = await downloadWorkerUsage(orchestratorRepository, initialPromotion.promotionRun.id, actionsToken);
    observability = recordControllerProviderObservation(observability, { runId: initialPromotion.promotionRun.id, stage: 'implementation', usage: promotionUsage.usage, evidenceRef: promotionUsage.evidenceRef ?? initialPromotion.promotionRun.html_url });
    if (promotionUsage.evidenceRef) evidenceRefs.push(promotionUsage.evidenceRef);
    evidenceRefs.push(initialTechnicalHygiene.evidenceRef);
  }

  await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'pending', description: 'Delivery V2 evaluation in progress', token: targetWriteToken, targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  await persist({ nextAction: 'observe-ci', workerRunId: worker.id, workerDispatchNonce: initialDispatchNonce, materialWorkerRunId: worker.id, materialWorkerIdentity: initialWorkerIdentity, materialWorkerProvider: initialWorkerProvider, technicalHygiene: state.technicalHygiene });

  for (let cycle = 0; cycle < 8; cycle += 1) {
    const observed = await waitRequiredCheck({
      repository: targetRepository,
      prNumber: pullRequest.number,
      sha: materialHeadSha,
      requiredStatusName: targetPolicy.requiredStatusName,
      workflowName: targetPolicy.ciWorkflowName,
      token: targetReadToken
    });

    if (observed.kind === 'head-drift') {
      pullRequest = observed.pullRequest;
      materialHeadSha = String(pullRequest.head.sha).toLowerCase();
      state = applyOperationalEvent(state, { type: 'head-drift', materialHeadSha });
      changedPaths = await fetchChangedPaths(targetRepository, pullRequest.number, targetReadToken);
      plan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
      state = applyOperationalEvent(state, { type: 'classify', riskProfile: plan.risk.profile });
      classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
      latestCheck = null;
      latestSourceRun = null;
      await persist({ nextAction: 'external-head-drift-requires-controller-resume', technicalHygiene: null });
      throw new Error('material head changed outside the bounded controller remediation step');
    }

    latestCheck = observed.check;
    latestSourceRun = observed.sourceRun;
    observability = recordControllerCiObservation(observability, {
      run: latestSourceRun,
      evidenceRef: latestSourceRun.html_url
    });
    const ciConclusion = latestCheck.conclusion === 'success' ? latestSourceRun.conclusion : latestCheck.conclusion;
    if (ciConclusion !== 'success') {
      const failureEvidence = await collectCiFailureEvidence({ repository: targetRepository, check: latestCheck, token: targetReadToken });
      const failureClass = ciFailureClassForEvidence({ conclusion: ciConclusion, failedJobs: failureEvidence.failedJobs });
      state = applyOperationalEvent(state, {
        type: 'ci-result',
        result: {
          candidateSha: materialHeadSha,
          conclusion: 'failure',
          failureClass,
          cause: `${latestCheck.name}:${ciConclusion}:${failureClass}`,
          evidenceRef: failureEvidence.workflowUrl ?? latestCheck.details_url ?? `github:check:${latestCheck.id}`
        }
      });
      evidenceRefs.push(latestCheck.details_url ?? `github:check:${latestCheck.id}`);
      await persist({ nextAction: failureClass === 'actionable' ? state.status : 'external-ci-blocker' });
      if (failureClass !== 'actionable') {
        await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'failure', description: `Delivery V2 blocked by external CI conclusion: ${latestCheck.conclusion}`, token: targetWriteToken });
        throw new Error(`required check ended with external/ambiguous conclusion ${latestCheck.conclusion}; refusing AI remediation`);
      }
      if (state.status === 'escalated') break;

      const remediation = operationalRemediationInput(state);
      state = applyOperationalEvent(state, { type: 'start-implementation' });
      if (state.status === 'escalated') {
        await persist({ nextAction: 'human-escalation' });
        break;
      }
      const workerDispatchNonce = createDispatchNonce();
      await persist({ nextAction: 'dispatch-ci-remediation', workerRunId: null, workerDispatchNonce });
      const beforeSha = materialHeadSha;
      worker = await dispatchWorker({
        orchestratorRepository, orchestratorRef, plan, controllerRunId, targetRepository, issueNumber, baseBranch,
        targetRef: beforeSha,
        targetPr: pullRequest.number,
        remediationContext: JSON.stringify(remediation),
        token: actionsToken,
        dispatchNonce: workerDispatchNonce
      });
      await persist({ nextAction: 'observe-remediation', workerRunId: worker.id, workerDispatchNonce });
      worker = await waitWorkflowRun(orchestratorRepository, worker.id, actionsToken);
      workerRuns.push(worker);
      const usage = await downloadWorkerUsage(orchestratorRepository, worker.id, actionsToken);
      observability = recordControllerProviderObservation(observability, {
        runId: worker.id,
        stage: 'implementation',
        usage: usage.usage,
        evidenceRef: usage.evidenceRef ?? worker.html_url
      });
      if (usage.evidenceRef) evidenceRefs.push(usage.evidenceRef);
      if (worker.conclusion !== 'success') throw new Error(`CI remediation worker failed: ${worker.html_url}`);
      pullRequest = await waitHeadChange(targetRepository, pullRequest.number, beforeSha, targetReadToken);
      materialHeadSha = String(pullRequest.head.sha).toLowerCase();
      const nextPaths = await fetchChangedPaths(targetRepository, pullRequest.number, targetReadToken);
      const nextPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths: nextPaths, repositoryPolicy });
      if (higherRisk(nextPlan.risk.profile, state.riskProfile)) {
        state = applyOperationalEvent(state, { type: 'escalate', reason: 'remediation-opened-higher-risk-surface', evidenceRef: worker.html_url });
        break;
      }
      changedPaths = nextPaths;
      plan = nextPlan;
      classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
      state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });
      let remediationTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });
      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: remediationTechnicalHygiene });
      evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);
      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: remediationTechnicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: pullRequest.number, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken, authorizePromotion: async ({ phase, dispatchNonce, runId, promotedState }) => {
        await persist({
          nextAction: phase === 'observe'
            ? 'observe-technical-hygiene'
            : 'dispatch-technical-hygiene',
          hygieneDispatchNonce: dispatchNonce,
          hygieneRunId: runId
        }, promotedState);
      } });
      if (hygienePromotion.promotionRun) {
        state = hygienePromotion.state;
        plan = hygienePromotion.plan;
        remediationTechnicalHygiene = hygienePromotion.hygiene;
        workerRuns.push(hygienePromotion.promotionRun);
        const promotionUsage = await downloadWorkerUsage(orchestratorRepository, hygienePromotion.promotionRun.id, actionsToken);
        observability = recordControllerProviderObservation(observability, { runId: hygienePromotion.promotionRun.id, stage: 'implementation', usage: promotionUsage.usage, evidenceRef: promotionUsage.evidenceRef ?? hygienePromotion.promotionRun.html_url });
        if (promotionUsage.evidenceRef) evidenceRefs.push(promotionUsage.evidenceRef);
        evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);
      }
      latestCheck = null;
      latestSourceRun = null;
      await persist({ nextAction: 'observe-ci', workerRunId: worker.id, materialWorkerRunId: worker.id, materialWorkerIdentity: plan.implementation.workflow, materialWorkerProvider: plan.implementation.provider, technicalHygiene: state.technicalHygiene });
      continue;
    }

    if (!latestSourceRun) {
      latestSourceRun = await sourceWorkflowRunForHead({ repository: targetRepository, sha: materialHeadSha, workflowName: targetPolicy.ciWorkflowName, token: targetReadToken });
    }
    evidenceRefs.push(latestCheck.details_url ?? latestSourceRun.html_url);
    state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: materialHeadSha, conclusion: 'success', evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url } });
    await persist({ nextAction: state.status });

    if (state.status === 'audit-pending') {
      state = applyOperationalEvent(state, { type: 'start-audit' });
      const auditDispatchNonce = createDispatchNonce();
      await persist({ nextAction: 'dispatch-audit', auditRunId: null, auditDispatchNonce });
      let auditRun = await dispatchWorkflowAndResolveRun({
        repository: orchestratorRepository,
        workflow: 'delivery-v2-audit.yml',
        ref: orchestratorRef,
        token: actionsToken,
        kind: 'audit',
        dispatchNonce: auditDispatchNonce,
        inputs: {
          target_repository: targetRepository,
          target_issue: String(issueNumber),
          target_pr: String(pullRequest.number),
          risk_profile: state.riskProfile,
          source_workflow_run_id: String(latestSourceRun.id),
          source_workflow_name: targetPolicy.ciWorkflowName,
          source_workflow_path: targetPolicy.ciWorkflowPath,
          implementation_attempt: String(state.implementationAttempts),
          implementer_provenance: 'known',
          implementer_provider: controller.materialWorkerProvider ?? initialWorkerProvider,
          implementer_worker_identity: controller.materialWorkerIdentity ?? initialWorkerIdentity,
          implementer_run_id: String(controller.materialWorkerRunId ?? worker.id),
          prior_findings_json: JSON.stringify(controller.priorFindings ?? [])
        }
      });
      await persist({ nextAction: 'observe-audit', auditRunId: auditRun.id, auditDispatchNonce });
      auditRun = await waitWorkflowRun(orchestratorRepository, auditRun.id, actionsToken);
      auditRuns.push(auditRun);
      if (auditRun.conclusion !== 'success') {
        const terminalReason =
          `independent-audit-workflow-${auditRun.conclusion ?? 'failed'}`;

        observability = recordControllerAuditWorkflowFailure(observability, {
          runId: auditRun.id,
          durationMs: runDurationMs(auditRun),
          evidenceRef: auditRun.html_url
        });

        const partialMetrics = createControllerPartialMetrics({
          observability,
          terminalReason
        });

        await persist({
          nextAction: 'audit-workflow-failed',
          auditRunId: auditRun.id,
          auditDispatchNonce,
          terminalReason,
          providerAccountingComplete:
            observability.providerAccountingComplete
        });

        const failurePayload = {
          schemaVersion: 1,
          status: 'audit-workflow-failed',
          repository: targetRepository,
          issueNumber,
          pullRequestNumber: pullRequest.number,
          materialHeadSha,
          risk: state.riskProfile,
          provider,
          providerCalls: partialMetrics.providerCalls,
          observedProviderCalls: partialMetrics.observedProviderCalls,
          observabilityHistoryComplete: false,
          metricsStatus: 'partial-audit-workflow-failure',
          metrics: null,
          partialMetrics,
          terminalReason,
          attempts: {
            implementation: state.implementationAttempts,
            audit: state.auditAttempts,
            auditRemediation: state.auditRemediationAttempts
          }
        };

        await writeFile(
          resultPath,
          `${JSON.stringify(failurePayload, null, 2)}\n`,
          'utf8'
        );

        throw new Error(
          `independent audit workflow failed: ${auditRun.html_url}`
        );
      }
      lastAudit = await auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber: pullRequest.number, candidateSha: materialHeadSha, auditRun, sourceWorkflowRunId: latestSourceRun.id, token: actionsToken });
      observability = recordControllerProviderObservation(observability, {
        runId: auditRun.id,
        stage: 'audit',
        usage: lastAudit.providerCalls === 0 ? { providerCalls: 0 } : (lastAudit.modelUsage ?? {}),
        durationMs: runDurationMs(auditRun),
        evidenceRef: auditRun.html_url
      });
      evidenceRefs.push(auditRun.html_url);
      state = applyOperationalEvent(state, {
        type: 'audit-result',
        result: {
          candidateSha: materialHeadSha,
          decision: lastAudit.decision,
          findings: lastAudit.findings,
          evidenceRef: auditRun.html_url
        }
      });
      const priorFindings = lastAudit.findings.map((finding) => ({ id: finding.id, candidateSha: finding.candidateSha, status: finding.blocksRelease ? 'open' : 'non-blocking' }));
      await persist({ nextAction: state.status, auditRunId: auditRun.id, auditRequestFingerprint: lastAudit.requestFingerprint, priorFindings });

      if (state.status === 'audit-failed-remediable') {
        const remediation = operationalRemediationInput(state);
        state = applyOperationalEvent(state, { type: 'start-implementation' });
        if (state.status === 'escalated') {
          await persist({ nextAction: 'human-escalation' });
          break;
        }
        const workerDispatchNonce = createDispatchNonce();
        await persist({ nextAction: 'dispatch-audit-remediation', workerRunId: null, workerDispatchNonce });
        const beforeSha = materialHeadSha;
        worker = await dispatchWorker({
          orchestratorRepository, orchestratorRef, plan, controllerRunId, targetRepository, issueNumber, baseBranch,
          targetRef: beforeSha,
          targetPr: pullRequest.number,
          remediationContext: JSON.stringify(remediation),
          token: actionsToken,
          dispatchNonce: workerDispatchNonce
        });
        await persist({ nextAction: 'observe-remediation', workerRunId: worker.id, workerDispatchNonce });
        worker = await waitWorkflowRun(orchestratorRepository, worker.id, actionsToken);
        workerRuns.push(worker);
        const usage = await downloadWorkerUsage(orchestratorRepository, worker.id, actionsToken);
        observability = recordControllerProviderObservation(observability, {
          runId: worker.id,
          stage: 'implementation',
          usage: usage.usage,
          evidenceRef: usage.evidenceRef ?? worker.html_url
        });
        if (usage.evidenceRef) evidenceRefs.push(usage.evidenceRef);
        if (worker.conclusion !== 'success') throw new Error(`audit remediation worker failed: ${worker.html_url}`);
        pullRequest = await waitHeadChange(targetRepository, pullRequest.number, beforeSha, targetReadToken);
        materialHeadSha = String(pullRequest.head.sha).toLowerCase();
        const nextPaths = await fetchChangedPaths(targetRepository, pullRequest.number, targetReadToken);
        const nextPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths: nextPaths, repositoryPolicy });
        if (higherRisk(nextPlan.risk.profile, state.riskProfile)) {
          state = applyOperationalEvent(state, { type: 'escalate', reason: 'audit-remediation-opened-higher-risk-surface', evidenceRef: worker.html_url });
          break;
        }
        changedPaths = nextPaths;
        plan = nextPlan;
        classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
        state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });
        let remediationTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });
        state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: remediationTechnicalHygiene });
        evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);
        const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: remediationTechnicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: pullRequest.number, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken, authorizePromotion: async ({ phase, dispatchNonce, runId, promotedState }) => {
        await persist({
          nextAction: phase === 'observe'
            ? 'observe-technical-hygiene'
            : 'dispatch-technical-hygiene',
          hygieneDispatchNonce: dispatchNonce,
          hygieneRunId: runId
        }, promotedState);
      } });
        if (hygienePromotion.promotionRun) {
          state = hygienePromotion.state;
          plan = hygienePromotion.plan;
          remediationTechnicalHygiene = hygienePromotion.hygiene;
          workerRuns.push(hygienePromotion.promotionRun);
          const promotionUsage = await downloadWorkerUsage(orchestratorRepository, hygienePromotion.promotionRun.id, actionsToken);
          observability = recordControllerProviderObservation(observability, { runId: hygienePromotion.promotionRun.id, stage: 'implementation', usage: promotionUsage.usage, evidenceRef: promotionUsage.evidenceRef ?? hygienePromotion.promotionRun.html_url });
          if (promotionUsage.evidenceRef) evidenceRefs.push(promotionUsage.evidenceRef);
          evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);
        }
        latestCheck = null;
        latestSourceRun = null;
        lastAudit = null;
        await persist({ nextAction: 'observe-ci', workerRunId: worker.id, workerDispatchNonce: null, materialWorkerRunId: worker.id, materialWorkerIdentity: plan.implementation.workflow, materialWorkerProvider: plan.implementation.provider, technicalHygiene: state.technicalHygiene, auditRunId: null, auditDispatchNonce: null, auditRequestFingerprint: null, priorFindings: (controller.priorFindings ?? []).map((finding) => ({ ...finding, status: 'remediated-pending-verification' })) });
        continue;
      }
    }

    if (state.status === 'technical-hygiene-pending') {
      state = applyOperationalEvent(state, { type: 'resolve-technical-hygiene' });
      await persist({ nextAction: state.status === 'escalated' ? 'human-escalation' : state.status });
    }

    if (state.status === 'ready-for-human-merge') {
      const audit = state.auditRequired ? {
        candidateSha: materialHeadSha,
        decision: lastAudit?.decision ?? 'approved',
        mode: state.auditMode,
        requestFingerprint: lastAudit?.requestFingerprint ?? 'not-observed',
        evidenceRef: auditRuns.at(-1)?.html_url ?? 'github:audit'
      } : null;
      const finalPullRequest = await fetchPullRequest(targetRepository, pullRequest.number, targetReadToken);
      const releaseIdentity = releaseIdentityFromPullRequest(finalPullRequest, { materialHeadSha, baseSha: expectedBaseSha });
      const mergePreview = await collectMergePreviewEvidence({ repository: targetRepository, pullRequest: finalPullRequest, materialHeadSha, baseSha: expectedBaseSha, workflowRun: latestSourceRun, requiredJobName: targetPolicy.mergePreviewJobName, token: targetReadToken });
      const releaseInput = {
        schemaVersion: 1,
        repository: targetRepository,
        pullRequestNumber: pullRequest.number,
        materialHeadSha,
        currentRemoteHeadSha: releaseIdentity.currentRemoteHeadSha,
        evidenceCollection: { materialHeadSha, remoteHeadSha: materialHeadSha, evidenceRef: `github:${targetRepository}#${pullRequest.number}@${materialHeadSha}` },
        classifier: {
          subjectSha: materialHeadSha,
          profile: state.riskProfile,
          version: classifier.version,
          fingerprint: classifier.fingerprint,
          expectedFingerprint: classifier.fingerprint,
          evidenceRef: classifier.evidenceRef
        },
        mergePreview,
        checks: [{ name: latestCheck.name, required: true, subjectSha: materialHeadSha, status: latestCheck.status, conclusion: latestCheck.conclusion, workflowRunId: latestSourceRun.id, evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url }],
        standardAuditRequired: targetPolicy.standardAuditRequired !== false,
        audit,
        unresolvedFindings: [],
        blockers: []
      };
      const release = evaluateOperationalRelease({ state, releaseInput });
      if (!release.readiness) throw new Error(`release gate did not become ready: ${release.reasons.join(', ')}`);
      await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'success', description: 'Delivery V2 exact-head release gate approved', token: targetWriteToken, targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
      await persist({ nextAction: 'human-merge-policy', release });
      break;
    }
    if (state.status === 'escalated') break;
  }

  if (state.status === 'escalated') {
    await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha,
      context: targetPolicy.finalStatusName, state: 'failure', description: state.terminalReason,
      token: targetWriteToken, targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  }
  pullRequest = await fetchPullRequest(targetRepository, pullRequest.number, targetReadToken);
  const metrics = createControllerDeliveryMetrics({
    observability,
    repository: targetRepository,
    issueNumber,
    pullRequestNumber: pullRequest.number,
    materialHeadSha: String(pullRequest.head.sha).toLowerCase(),
    risk: state.riskProfile,
    provider,
    classifier: { version: classifier.version, fingerprint: classifier.fingerprint },
    attempts: { implementation: state.implementationAttempts, audit: state.auditAttempts },
    change: { files: pullRequest.changed_files ?? 0, additions: pullRequest.additions ?? 0, deletions: pullRequest.deletions ?? 0 },
    terminalReason: state.status === 'ready-for-human-merge' ? 'ready-for-human-merge' : (state.terminalReason ?? state.status),
    escalated: state.status === 'escalated',
    evidenceRefs
  });

  const payload = {
    schemaVersion: 1,
    status: state.status,
    repository: targetRepository,
    issueNumber,
    pullRequestNumber: pullRequest.number,
    materialHeadSha: String(pullRequest.head.sha).toLowerCase(),
    risk: state.riskProfile,
    workerRuns: workerRuns.map((run) => ({ id: run.id, conclusion: run.conclusion, url: run.html_url })),
    auditRuns: auditRuns.map((run) => ({ id: run.id, conclusion: run.conclusion, url: run.html_url })),
    metrics
  };
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!['ready-for-human-merge', 'escalated'].includes(state.status)) throw new Error(`controller stopped in non-terminal state ${state.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
