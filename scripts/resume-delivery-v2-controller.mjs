#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import {
  applyOperationalEvent,
  createOperationalDelivery,
  operationalRemediationInput,
  operationalStateFromPersistent,
  evaluateOperationalRelease,
  persistentStateFromOperational
} from '../src/v2/operational-controller.mjs';
import { reconcilePersistentState } from '../src/v2/persistent-state.mjs';
import { ciFailureClassForEvidence, collectCiFailureEvidence, collectMergePreviewEvidence, createDispatchNonce, loadAuthoritativeAuditResult, publishReleaseStatus, releaseIdentityFromPullRequest, selectCorrelatedWorkflowRun } from '../src/v2/controller-runtime.mjs';
import { selectAuthoritativeSourceWorkflowRun, selectCheckForWorkflowRun } from '../src/v2/ci-evidence-correlation.mjs';
import { parseTrustedJsonEnvelope, selectTrustedMarkerComment, trustedCommentAuthorForRepository, validateControllerRunProvenance } from '../src/v2/controller-provenance.mjs';
import { normalizeControllerTargetPolicy } from '../src/v2/controller-target-policy.mjs';
import {
  createControllerDeliveryMetrics,
  createControllerObservability,
  createControllerPartialMetrics,
  normalizeControllerObservability,
  recordControllerAuditWorkflowFailure,
  recordControllerCiObservation,
  recordControllerProviderObservation,
  runDurationMs
} from '../src/v2/controller-observability.mjs';
import { downloadGhAwUsageArtifact } from '../src/v2/gh-aw-usage-artifact.mjs';
import { downloadGhAwTechnicalHygieneArtifact } from '../src/v2/gh-aw-hygiene-artifact.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const RISK_RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });
const POLL_MS = Number(process.env.DELIVERY_V2_POLL_MS || 10000);
const MAX_STAGE_MS = Number(process.env.DELIVERY_V2_STAGE_TIMEOUT_MS || 75 * 60 * 1000);

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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-resume-controller'
  };
}

async function api(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(token), ...(options.headers ?? {}) }
  });
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

async function listComments(repository, prNumber, token) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`, token);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

function parseStateComment(comments, trustedLogin) {
  const parsed = parseTrustedJsonEnvelope(comments, { marker: STATE_MARKER, label: 'Delivery V2 state', trustedLogin });
  if (!parsed) return null;
  const envelope = parsed.value;
  if (!envelope?.persistent) throw new Error('Delivery V2 state comment is missing persistent state');
  return Object.freeze({ commentId: parsed.commentId, persistent: envelope.persistent, controller: envelope.controller ?? {} });
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

function checkEvidence(check, sourceRun, sha) {
  if (!check || !sourceRun) return [];
  return [{
    name: check.name,
    subjectSha: sha,
    status: check.status,
    conclusion: check.conclusion,
    workflowRunId: sourceRun.id,
    evidenceRef: check.details_url ?? sourceRun.html_url ?? `github:${sha}`
  }];
}

async function upsertStateComment({ repository, prNumber, state, identity, classifier, latestCheck, latestSourceRun, token, extra = {} }) {
  const persistent = persistentStateFromOperational({
    state,
    identity,
    classifier,
    workflowChecks: checkEvidence(latestCheck, latestSourceRun, state.materialHeadSha),
    evidenceRefs: [latestCheck?.details_url, latestSourceRun?.html_url].filter(Boolean)
  });
  const body = `${STATE_MARKER}\n## Delivery V2 controller state\n\n\`\`\`json\n${JSON.stringify({ persistent, controller: extra }, null, 2)}\n\`\`\``;
  const comments = await listComments(repository, prNumber, token);
  const existing = selectTrustedMarkerComment(comments, { marker: STATE_MARKER, label: 'Delivery V2 state', trustedLogin: trustedCommentAuthorForRepository(repository) });
  if (existing) await patchJson(`https://api.github.com/repos/${repository}/issues/comments/${existing.id}`, token, { body });
  else await postJson(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments`, token, { body });
  return persistent;
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
    if (String(pr.head.sha).toLowerCase() !== sha.toLowerCase()) return { kind: 'head-drift', pullRequest: pr };
    const sourceRun = await sourceWorkflowRunForHead({ repository, sha, workflowName, token });
    if (!sourceRun) { await sleep(POLL_MS); continue; }
    const check = selectCheckForWorkflowRun(await fetchCheckRuns(repository, sha, token), { requiredStatusName, workflowRunId: sourceRun.id });
    if (sourceRun.status === 'completed' && check?.status === 'completed') return { kind: 'check', check, sourceRun, pullRequest: pr };
    if (sourceRun.status === 'completed' && !check) throw new Error(`required check ${requiredStatusName} is missing for authoritative workflow run ${sourceRun.id}`);
    await sleep(POLL_MS);
  }
  throw new Error(`required check ${requiredStatusName} did not become terminal within bounded timeout`);
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

async function waitHeadChange(repository, prNumber, previousSha, token) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const pr = await fetchPullRequest(repository, prNumber, token);
    if (String(pr.head.sha).toLowerCase() !== previousSha.toLowerCase()) return pr;
    await sleep(POLL_MS);
  }
  throw new Error('in-flight remediation completed without publishing a new material head');
}

async function dispatchWorker({ orchestratorRepository, orchestratorRef, plan, controllerRunId, targetRepository, issueNumber, baseBranch, targetRef, targetPr, remediationContext, token, dispatchNonce = createDispatchNonce() }) {
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
      target_pr: String(targetPr),
      remediation_context: remediationContext
    }
  });
}

async function auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber, candidateSha, auditRun, sourceWorkflowRunId, token }) {
  return loadAuthoritativeAuditResult({ orchestratorRepository, trustedRef: orchestratorRef, targetRepository, issueNumber, pullRequestNumber: prNumber, candidateSha, auditRun, sourceWorkflowRunId, token });
}

function higherRisk(next, current) { return RISK_RANK[next] > RISK_RANK[current]; }

async function ensurePromotedTechnicalHygiene({ hygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber, materialHeadSha, baselineSha, previousMaterialSha = null, actionsToken, targetReadToken }) {
  if (!hygiene?.promotionRequired) return { hygiene, state, plan, promotionRun: null };
  const promotedPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk: 'standard', changedPaths, repositoryPolicy });
  let promotedState = applyOperationalEvent(state, { type: 'promote-risk', plan: promotedPlan });
  const dispatchNonce = createDispatchNonce();
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
  promotionRun = await waitWorkflowRun(orchestratorRepository, promotionRun.id, actionsToken);
  if (promotionRun.conclusion !== 'success') throw new Error(`technical hygiene STANDARD promotion worker failed: ${promotionRun.html_url}`);
  const currentPr = await fetchPullRequest(targetRepository, pullRequestNumber, targetReadToken);
  if (String(currentPr.head.sha).toLowerCase() !== materialHeadSha.toLowerCase()) throw new Error('technical hygiene evidence-only promotion mutated the material head');
  const reevaluated = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: promotionRun.id, token: actionsToken, baselineSha, materialSha: materialHeadSha, previousMaterialSha, profile: promotedState.riskProfile });
  promotedState = applyOperationalEvent(promotedState, { type: 'technical-hygiene-result', result: reevaluated });
  if (!['PASS', 'PASS_WITH_DEBT'].includes(reevaluated.result)) throw new Error(`technical hygiene remained ${reevaluated.result} after ${promotedState.riskProfile.toUpperCase()} re-evaluation`);
  return { hygiene: reevaluated, state: promotedState, plan: promotedPlan, promotionRun };
}

export function controllerMetadataForNewMaterial({ controller = {}, workerRunId, plan } = {}) {
  const resolvedRunId = Number(workerRunId);
  if (!Number.isInteger(resolvedRunId) || resolvedRunId < 1) throw new Error('workerRunId must identify the material-producing worker run');
  const workerIdentity = String(plan?.implementation?.workflow ?? '').trim();
  const workerProvider = String(plan?.implementation?.provider ?? '').trim().toLowerCase();
  if (!workerIdentity || !workerProvider) throw new Error('material worker plan identity is required');
  return Object.freeze({
    workerRunId: null,
    workerDispatchNonce: null,
    materialWorkerRunId: resolvedRunId,
    materialWorkerIdentity: workerIdentity,
    materialWorkerProvider: workerProvider,
    auditRunId: null,
    auditDispatchNonce: null,
    auditRequestFingerprint: null,
    priorFindings: (controller.priorFindings ?? []).map((finding) => ({ ...finding, status: 'remediated-pending-verification' }))
  });
}

export function rebuildCiPendingState({ plan, materialHeadSha, previousState }) {
  const fresh = createOperationalDelivery({ plan, materialHeadSha });
  return Object.freeze({
    ...fresh,
    implementationAttempts: Math.max(fresh.implementationAttempts, previousState?.implementationAttempts ?? 0),
    auditAttempts: previousState?.auditAttempts ?? 0,
    auditRemediationAttempts: previousState?.auditRemediationAttempts ?? 0
  });
}

export function markExistingAuditInFlight(state) {
  if (state.status !== 'audit-pending' || state.auditAttempts < 1) throw new Error('existing audit requires audit-pending state with a reserved attempt');
  return Object.freeze({ ...state, auditInFlight: true });
}

export function initializeResumeObservability(controller = {}, { startedAtMs = Date.now() } = {}) {
  const hasPersistedObservability = Boolean(controller?.observability);
  const explicitHistoryComplete = controller?.observabilityHistoryComplete;
  if (explicitHistoryComplete != null && typeof explicitHistoryComplete !== 'boolean') {
    throw new Error('controller.observabilityHistoryComplete must be boolean when present');
  }
  if (explicitHistoryComplete === true && !hasPersistedObservability) {
    throw new Error('complete observability history requires persisted observability');
  }
  const observability = hasPersistedObservability
    ? normalizeControllerObservability(controller.observability)
    : createControllerObservability({ startedAtMs });

  const declaredHistoryComplete =
    explicitHistoryComplete ?? hasPersistedObservability;

  return Object.freeze({
    observability,
    historyComplete:
      declaredHistoryComplete &&
      observability.ciTimingHistoryComplete &&
      observability.providerAccountingComplete &&
      observability.auditTimingComplete
  });
}

export async function main() {
  const resumeStartedAtMs = Date.now();
  const targetRepository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  const provider = requiredEnv('DELIVERY_AI_PROVIDER').toLowerCase();
  const requestedRisk = requiredEnv('DELIVERY_RISK_PROFILE').toLowerCase();
  const resumePr = positiveInteger(requiredEnv('DELIVERY_V2_RESUME_PR'), 'DELIVERY_V2_RESUME_PR');
  const orchestratorRepository = requiredEnv('GITHUB_REPOSITORY');
  const orchestratorRef = requiredEnv('ORCHESTRATOR_WORKER_REF');
  const targetReadToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const targetWriteToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');
  const actionsToken = requiredEnv('GITHUB_TOKEN');
  const controllerRunId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');
  const resultPath = process.env.CONTROLLER_RESULT_PATH || path.join(process.env.RUNNER_TEMP || '/tmp', 'delivery-v2-controller-result.json');
  const targetPolicy = await loadControllerTarget(targetRepository, baseBranch);
  const repositoryPolicy = await loadRepositoryRiskPolicy(targetRepository);

  let pullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
  if (pullRequest.state !== 'open') throw new Error(`managed PR #${resumePr} is not open`);
  if (String(pullRequest.base.ref) !== baseBranch) throw new Error('managed PR base branch does not match requested base');
  if (!String(pullRequest.title ?? '').startsWith('[delivery-v2] ')) throw new Error('managed PR is missing Delivery V2 title prefix');
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
  if (!closing.test(String(pullRequest.body ?? ''))) throw new Error('managed PR is not bound to requested issue');

  let materialHeadSha = String(pullRequest.head.sha).toLowerCase();
  const expectedBaseSha = String(pullRequest.base.sha).toLowerCase();
  let changedPaths = await fetchChangedPaths(targetRepository, resumePr, targetReadToken);
  let plan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
  let classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
  let latestCheck = null;
  let latestSourceRun = null;

  const trustedLogin = trustedCommentAuthorForRepository(targetRepository);
  const stateEnvelope = parseStateComment(await listComments(targetRepository, resumePr, targetReadToken), trustedLogin);
  if (!stateEnvelope) throw new Error('managed PR is missing authoritative Delivery V2 persistent state');
  const resumeObservability = initializeResumeObservability(stateEnvelope.controller, { startedAtMs: resumeStartedAtMs });
  let observability = resumeObservability.observability;
  const observabilityHistoryComplete = resumeObservability.historyComplete;
  const priorControllerRunId = positiveInteger(stateEnvelope.controller?.controllerRunId, 'persisted controllerRunId');
  const priorControllerRun = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${priorControllerRunId}`, actionsToken);
  validateControllerRunProvenance(priorControllerRun, { orchestratorRepository, trustedRef: orchestratorRef });
  let state;
  let controller = {
    ...stateEnvelope.controller,
    controllerRunId,
    controllerRepository: orchestratorRepository,
    controllerRef: orchestratorRef,
    controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml',
    observability,
    observabilityHistoryComplete
  };
  if (stateEnvelope) {
    const reconciled = reconcilePersistentState(stateEnvelope.persistent, {
      repository: targetRepository,
      pullRequestNumber: resumePr,
      headRef: String(pullRequest.head.ref),
      baseSha: String(pullRequest.base.sha),
      remoteHeadSha: materialHeadSha
    });
    state = operationalStateFromPersistent(reconciled.state);
    if (!reconciled.staleStateDetected && stateEnvelope.controller?.technicalHygiene) {
      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: stateEnvelope.controller.technicalHygiene });
    }
    if (reconciled.staleStateDetected || ['queued', 'classified', 'ci-failed-remediable'].includes(state.status)) {
      state = rebuildCiPendingState({ plan, materialHeadSha, previousState: state });
      const materialIdentityStale = String(stateEnvelope.persistent.materialHeadSha).toLowerCase() !== materialHeadSha;
      controller = {
        ...controller,
        nextAction: 'observe-ci',
        resumedFrom: reconciled.nextAction,
        auditRunId: null,
        auditDispatchNonce: null,
        auditRequestFingerprint: null,
        technicalHygiene: materialIdentityStale ? null : controller.technicalHygiene ?? null,
        ...(materialIdentityStale ? { materialWorkerRunId: null, materialWorkerIdentity: null, materialWorkerProvider: null } : {})
      };
    }
  } else {
    throw new Error('managed PR is missing canonical persistent Delivery V2 state; refusing to reset unknown attempt budgets');
  }

  const identity = () => ({
    issueNumber,
    pullRequestNumber: resumePr,
    baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
    headRef: pullRequest.head.ref,
    provider
  });

  const persist = async (extra = {}) => {
    controller = { ...controller, observability, observabilityHistoryComplete, ...extra };
    return upsertStateComment({
      repository: targetRepository,
      prNumber: resumePr,
      state,
      identity: identity(),
      classifier,
      latestCheck,
      latestSourceRun,
      token: targetWriteToken,
      extra: controller
    });
  };

  const recordWorkerUsage = async (run) => {
    const usage = await downloadGhAwUsageArtifact({ repository: orchestratorRepository, runId: run.id, token: actionsToken });
    observability = recordControllerProviderObservation(observability, {
      runId: run.id,
      stage: 'implementation',
      usage: usage.usage,
      evidenceRef: usage.evidenceRef ?? run.html_url
    });
  };

  await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'pending', description: 'Delivery V2 resumed evaluation in progress', token: targetWriteToken, targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  await persist({ nextAction: state.status });

  for (let cycle = 0; cycle < 8; cycle += 1) {
    if (['ready-for-human-merge', 'escalated', 'terminal'].includes(state.status)) break;

    if (state.status === 'implementing') {
      let workerRunId = Number(controller.workerRunId ?? 0);
      if ((!Number.isInteger(workerRunId) || workerRunId < 1) && controller.workerDispatchNonce) {
        const recovered = selectCorrelatedWorkflowRun(await listWorkflowRuns(orchestratorRepository, plan.implementation.workflow, actionsToken), { kind: 'worker', nonce: controller.workerDispatchNonce, ref: orchestratorRef });
        if (!recovered) throw new Error('cannot safely recover in-flight implementation by dispatch nonce; refusing duplicate worker');
        workerRunId = recovered.id;
        await persist({ nextAction: 'observe-remediation', workerRunId, workerDispatchNonce: controller.workerDispatchNonce });
      }
      if (!Number.isInteger(workerRunId) || workerRunId < 1) throw new Error('cannot safely resume an in-flight implementation without persisted worker identity');
      const run = await waitWorkflowRun(orchestratorRepository, workerRunId, actionsToken);
      await recordWorkerUsage(run);
      if (run.conclusion !== 'success') {
        await persist({ nextAction: 'remediation-worker-failed', workerRunId: run.id });
        await publishReleaseStatus({
          repository: targetRepository,
          sha: materialHeadSha,
          context: targetPolicy.finalStatusName,
          state: 'failure',
          description: 'Delivery V2 remediation worker failed',
          token: targetWriteToken,
          targetUrl: run.html_url
        });
        throw new Error(`persisted remediation worker failed: ${run.html_url}`);
      }
      const beforeSha = materialHeadSha;
      pullRequest = await waitHeadChange(targetRepository, resumePr, beforeSha, targetReadToken);
      materialHeadSha = String(pullRequest.head.sha).toLowerCase();
      changedPaths = await fetchChangedPaths(targetRepository, resumePr, targetReadToken);
      const nextPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
      if (higherRisk(nextPlan.risk.profile, state.riskProfile)) {
        state = applyOperationalEvent(state, { type: 'escalate', reason: 'remediation-opened-higher-risk-surface', evidenceRef: run.html_url });
        await persist({ nextAction: 'human-escalation' });
        break;
      }
      plan = nextPlan;
      classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
      state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });
      let technicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: run.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });
      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: technicalHygiene });
      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: technicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: resumePr, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken });
      if (hygienePromotion.promotionRun) {
        await recordWorkerUsage(hygienePromotion.promotionRun);
        state = hygienePromotion.state;
        plan = hygienePromotion.plan;
        technicalHygiene = hygienePromotion.hygiene;
      }
      latestCheck = null;
      latestSourceRun = null;
      await persist({ nextAction: 'observe-ci', ...controllerMetadataForNewMaterial({ controller, workerRunId: run.id, plan }), technicalHygiene: state.technicalHygiene });
      continue;
    }

    if (state.status === 'ci-pending') {
      const observed = await waitRequiredCheck({
        repository: targetRepository,
        prNumber: resumePr,
        sha: materialHeadSha,
        requiredStatusName: targetPolicy.requiredStatusName,
        workflowName: targetPolicy.ciWorkflowName,
        token: targetReadToken
      });
      if (observed.kind === 'head-drift') {
        pullRequest = observed.pullRequest;
        materialHeadSha = String(pullRequest.head.sha).toLowerCase();
        changedPaths = await fetchChangedPaths(targetRepository, resumePr, targetReadToken);
        plan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
        classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
        state = rebuildCiPendingState({ plan, materialHeadSha, previousState: state });
        latestCheck = null;
        latestSourceRun = null;
        await persist({ nextAction: 'observe-ci', reason: 'reconciled-head-drift', technicalHygiene: null });
        continue;
      }

      latestCheck = observed.check;
      latestSourceRun = observed.sourceRun;
      observability = recordControllerCiObservation(observability, {
        run: latestSourceRun,
        evidenceRef: latestSourceRun.html_url
      });
      const ciConclusion = latestCheck.conclusion === 'success' ? latestSourceRun.conclusion : latestCheck.conclusion;
      if (ciConclusion === 'success') {
        state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: materialHeadSha, conclusion: 'success', evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url } });
        await persist({ nextAction: state.status });
        continue;
      }

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
      await persist({ nextAction: failureClass === 'actionable' ? state.status : 'external-ci-blocker' });
      if (failureClass !== 'actionable') {
        await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'failure', description: `Delivery V2 blocked by external CI conclusion: ${latestCheck.conclusion}`, token: targetWriteToken });
        throw new Error(`required check ended with external/ambiguous conclusion ${latestCheck.conclusion}; refusing AI remediation`);
      }
      continue;
    }

    if (state.status === 'ci-failed-remediable' || state.status === 'audit-failed-remediable') {
      const remediation = operationalRemediationInput(state);
      const beforeSha = materialHeadSha;
      state = applyOperationalEvent(state, { type: 'start-implementation' });
      const workerDispatchNonce = createDispatchNonce();
      await persist({ nextAction: 'dispatch-remediation', workerRunId: null, workerDispatchNonce });
      let worker = await dispatchWorker({
        orchestratorRepository,
        orchestratorRef,
        plan,
        controllerRunId,
        targetRepository,
        issueNumber,
        baseBranch,
        targetRef: beforeSha,
        targetPr: resumePr,
        remediationContext: JSON.stringify(remediation),
        token: actionsToken,
        dispatchNonce: workerDispatchNonce
      });
      await persist({ nextAction: 'observe-remediation', workerRunId: worker.id, workerDispatchNonce });
      worker = await waitWorkflowRun(orchestratorRepository, worker.id, actionsToken);
      await recordWorkerUsage(worker);
      if (worker.conclusion !== 'success') {
        await persist({
          nextAction: 'remediation-worker-failed',
          workerRunId: worker.id,
          workerDispatchNonce
        });
        await publishReleaseStatus({
          repository: targetRepository,
          sha: materialHeadSha,
          context: targetPolicy.finalStatusName,
          state: 'failure',
          description: 'Delivery V2 remediation worker failed',
          token: targetWriteToken,
          targetUrl: worker.html_url
        });
        throw new Error(`remediation worker failed: ${worker.html_url}`);
      }
      pullRequest = await waitHeadChange(targetRepository, resumePr, beforeSha, targetReadToken);
      materialHeadSha = String(pullRequest.head.sha).toLowerCase();
      changedPaths = await fetchChangedPaths(targetRepository, resumePr, targetReadToken);
      const nextPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
      if (higherRisk(nextPlan.risk.profile, state.riskProfile)) {
        state = applyOperationalEvent(state, { type: 'escalate', reason: 'remediation-opened-higher-risk-surface', evidenceRef: worker.html_url });
        await persist({ nextAction: 'human-escalation', workerRunId: null });
        break;
      }
      plan = nextPlan;
      classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
      state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });
      let technicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });
      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: technicalHygiene });
      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: technicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: resumePr, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken });
      if (hygienePromotion.promotionRun) {
        await recordWorkerUsage(hygienePromotion.promotionRun);
        state = hygienePromotion.state;
        plan = hygienePromotion.plan;
        technicalHygiene = hygienePromotion.hygiene;
      }
      latestCheck = null;
      latestSourceRun = null;
      await persist({ nextAction: 'observe-ci', ...controllerMetadataForNewMaterial({ controller, workerRunId: worker.id, plan }), technicalHygiene: state.technicalHygiene });
      continue;
    }

    if (state.status === 'audit-pending') {
      let auditRun;
      if (controller.auditRunId) {
        state = markExistingAuditInFlight(state);
        auditRun = await waitWorkflowRun(orchestratorRepository, Number(controller.auditRunId), actionsToken);
      } else if (state.auditAttempts > 0 && controller.auditDispatchNonce) {
        const recovered = selectCorrelatedWorkflowRun(await listWorkflowRuns(orchestratorRepository, 'delivery-v2-audit.yml', actionsToken), { kind: 'audit', nonce: controller.auditDispatchNonce, ref: orchestratorRef });
        if (!recovered) throw new Error('cannot safely recover in-flight audit by dispatch nonce; refusing duplicate audit');
        state = markExistingAuditInFlight(state);
        auditRun = await waitWorkflowRun(orchestratorRepository, recovered.id, actionsToken);
        await persist({ nextAction: 'observe-audit', auditRunId: recovered.id, auditDispatchNonce: controller.auditDispatchNonce });
      } else if (state.auditAttempts > 0) {
        throw new Error('cannot safely resume audit-pending state without persisted audit identity; refusing duplicate audit');
      } else {
        state = applyOperationalEvent(state, { type: 'start-audit' });
        const auditDispatchNonce = createDispatchNonce();
        await persist({ nextAction: 'dispatch-audit', auditRunId: null, auditDispatchNonce });
        const sourceRun = latestSourceRun ?? await sourceWorkflowRunForHead({ repository: targetRepository, sha: materialHeadSha, workflowName: targetPolicy.ciWorkflowName, token: targetReadToken });
        auditRun = await dispatchWorkflowAndResolveRun({
          repository: orchestratorRepository,
          workflow: 'delivery-v2-audit.yml',
          ref: orchestratorRef,
          token: actionsToken,
          kind: 'audit',
          dispatchNonce: auditDispatchNonce,
          inputs: {
            target_repository: targetRepository, target_issue: String(issueNumber), target_pr: String(resumePr),
            risk_profile: state.riskProfile, source_workflow_run_id: String(sourceRun.id), source_workflow_name: targetPolicy.ciWorkflowName,
            source_workflow_path: targetPolicy.ciWorkflowPath, implementation_attempt: String(state.implementationAttempts),
            implementer_provider: controller.materialWorkerProvider ?? provider,
            implementer_worker_identity: controller.materialWorkerIdentity ?? plan.implementation.workflow,
            implementer_run_id: String(controller.materialWorkerRunId ?? controller.workerRunId),
            prior_findings_json: JSON.stringify(controller.priorFindings ?? [])
          }
        });
        await persist({ nextAction: 'observe-audit', auditRunId: auditRun.id, auditDispatchNonce });
        auditRun = await waitWorkflowRun(orchestratorRepository, auditRun.id, actionsToken);
      }
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
          auditDispatchNonce: controller.auditDispatchNonce,
          terminalReason,
          providerAccountingComplete:
            observability.providerAccountingComplete
        });

        const failurePayload = {
          schemaVersion: 1,
          status: 'audit-workflow-failed',
          repository: targetRepository,
          issueNumber,
          pullRequestNumber: resumePr,
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
          resumed: true,
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
      const sourceRun = latestSourceRun ?? await sourceWorkflowRunForHead({ repository: targetRepository, sha: materialHeadSha, workflowName: targetPolicy.ciWorkflowName, token: targetReadToken });
      const result = await auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber: resumePr, candidateSha: materialHeadSha, auditRun, sourceWorkflowRunId: sourceRun.id, token: actionsToken });
      observability = recordControllerProviderObservation(observability, {
        runId: auditRun.id,
        stage: 'audit',
        usage: result.providerCalls === 0 ? { providerCalls: 0 } : (result.modelUsage ?? {}),
        durationMs: runDurationMs(auditRun),
        evidenceRef: auditRun.html_url
      });
      state = applyOperationalEvent(state, { type: 'audit-result', result: { candidateSha: materialHeadSha, decision: result.decision, findings: result.findings, evidenceRef: auditRun.html_url } });
      const priorFindings = result.findings.map((finding) => ({ id: finding.id, candidateSha: finding.candidateSha, status: finding.blocksRelease ? 'open' : 'non-blocking' }));
      await persist({ nextAction: state.status, auditRunId: auditRun.id, auditDispatchNonce: controller.auditDispatchNonce, auditRequestFingerprint: result.requestFingerprint, priorFindings });
      continue;
    }

    throw new Error(`unsupported resumed controller state: ${state.status}`);
  }

  if (state.status === 'ready-for-human-merge') {
    pullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
    materialHeadSha = String(pullRequest.head.sha).toLowerCase();
    latestCheck = (await fetchCheckRuns(targetRepository, materialHeadSha, targetReadToken)).find((item) => item.name === targetPolicy.requiredStatusName);
    if (!latestCheck || latestCheck.status !== 'completed' || latestCheck.conclusion !== 'success') throw new Error('release gate requires exact-head terminal green source CI');
    latestSourceRun = await sourceWorkflowRunForHead({ repository: targetRepository, sha: materialHeadSha, workflowName: targetPolicy.ciWorkflowName, token: targetReadToken });
    observability = recordControllerCiObservation(observability, {
      run: latestSourceRun,
      evidenceRef: latestSourceRun.html_url
    });
    let audit = null;
    if (state.auditRequired) {
      const auditRunId = positiveInteger(controller.auditRunId, 'persisted auditRunId');
      const auditRun = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${auditRunId}`, actionsToken);
      const auditResult = await auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber: resumePr, candidateSha: materialHeadSha, auditRun, sourceWorkflowRunId: latestSourceRun.id, token: actionsToken });
      if (auditResult.decision !== 'approved') throw new Error('release gate requires approved authoritative audit');
      observability = recordControllerProviderObservation(observability, {
        runId: auditRun.id,
        stage: 'audit',
        usage: auditResult.providerCalls === 0 ? { providerCalls: 0 } : (auditResult.modelUsage ?? {}),
        durationMs: runDurationMs(auditRun),
        evidenceRef: auditRun.html_url
      });
      audit = { candidateSha: materialHeadSha, decision: 'approved', mode: state.auditMode, requestFingerprint: auditResult.requestFingerprint, evidenceRef: auditRun.html_url };
    }
    const finalPullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
    const releaseIdentity = releaseIdentityFromPullRequest(finalPullRequest, { materialHeadSha, baseSha: expectedBaseSha });
    const mergePreview = await collectMergePreviewEvidence({ repository: targetRepository, pullRequest: finalPullRequest, materialHeadSha, baseSha: expectedBaseSha, workflowRun: latestSourceRun, requiredJobName: targetPolicy.mergePreviewJobName, token: targetReadToken });
    const releaseInput = {
      schemaVersion: 1, repository: targetRepository, pullRequestNumber: resumePr, materialHeadSha, currentRemoteHeadSha: releaseIdentity.currentRemoteHeadSha,
      evidenceCollection: { materialHeadSha, remoteHeadSha: materialHeadSha, evidenceRef: `github:${targetRepository}#${resumePr}@${materialHeadSha}` },
      classifier: { subjectSha: materialHeadSha, profile: state.riskProfile, version: classifier.version, fingerprint: classifier.fingerprint, expectedFingerprint: classifier.fingerprint, evidenceRef: classifier.evidenceRef },
      mergePreview,
      checks: [{ name: latestCheck.name, required: true, subjectSha: materialHeadSha, status: latestCheck.status, conclusion: latestCheck.conclusion, workflowRunId: latestSourceRun.id, evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url }],
      standardAuditRequired: targetPolicy.standardAuditRequired !== false, audit, unresolvedFindings: [], blockers: []
    };
    const release = evaluateOperationalRelease({ state, releaseInput });
    if (!release.readiness) throw new Error(`release gate did not become ready: ${release.reasons.join(', ')}`);
    await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'success', description: 'Delivery V2 exact-head release gate approved', token: targetWriteToken, targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
    await persist({ nextAction: 'human-merge-policy', release });
  }

  pullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
  const metrics = observabilityHistoryComplete ? createControllerDeliveryMetrics({
    observability,
    repository: targetRepository,
    issueNumber,
    pullRequestNumber: resumePr,
    materialHeadSha: String(pullRequest.head.sha).toLowerCase(),
    risk: state.riskProfile,
    provider,
    classifier: { version: classifier.version, fingerprint: classifier.fingerprint },
    attempts: { implementation: state.implementationAttempts, audit: state.auditAttempts },
    change: { files: pullRequest.changed_files ?? 0, additions: pullRequest.additions ?? 0, deletions: pullRequest.deletions ?? 0 },
    terminalReason: state.status === 'ready-for-human-merge' ? 'ready-for-human-merge' : (state.terminalReason ?? state.status),
    escalated: state.status === 'escalated',
    evidenceRefs: [latestCheck?.details_url, latestSourceRun?.html_url].filter(Boolean)
  }) : null;
  const partialMetrics = observabilityHistoryComplete ? null : {
    schemaVersion: 1,
    scope: 'observed-since-legacy-resume',
    startedAtMs: observability.startedAtMs,
    providerCalls: observability.providerCalls,
    aiUsageByStage: observability.aiUsageByStage,
    auditDurationMs: observability.auditDurationMs,
    ciTimingHistoryComplete: observability.ciTimingHistoryComplete,
    ciRunIds: observability.ciRunIds,
    durationsMs: {
      ciQueue: observability.ciQueueDurationMs,
      ciExecution: observability.ciExecutionDurationMs,
      endToEnd: Math.max(0, Date.now() - observability.startedAtMs)
    },
    evidenceRefs: observability.evidenceRefs
  };
  const payload = {
    schemaVersion: 1,
    status: state.status,
    repository: targetRepository,
    issueNumber,
    pullRequestNumber: resumePr,
    materialHeadSha: String(pullRequest.head.sha).toLowerCase(),
    risk: state.riskProfile,
    providerCalls: metrics?.providerCalls ?? null,
    observedProviderCalls: observability.providerCalls,
    observabilityHistoryComplete,
    metricsStatus: metrics ? 'complete' : 'partial-legacy-observability',
    metrics,
    partialMetrics,
    resumed: true,
    attempts: {
      implementation: state.implementationAttempts,
      audit: state.auditAttempts,
      auditRemediation: state.auditRemediationAttempts
    }
  };
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!['ready-for-human-merge', 'escalated', 'terminal'].includes(state.status)) throw new Error(`resumed controller stopped in non-terminal state ${state.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
