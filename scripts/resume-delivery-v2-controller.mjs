#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadV2Config } from '../src/v2/config.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import {
  applyOperationalEvent,
  createAdoptedOperationalDelivery,
  createOperationalDelivery,
  operationalRemediationInput,
  operationalStateFromPersistent,
  evaluateOperationalRelease,
  persistentStateFromOperational
} from '../src/v2/operational-controller.mjs';
import { reconcilePersistentState } from '../src/v2/persistent-state.mjs';
import { ciFailureClassForEvidence, collectCiFailureEvidence, collectMergePreviewEvidence, createDispatchNonce, loadAuthoritativeAuditResult, publishReleaseStatus, releaseIdentityFromPullRequest, selectCorrelatedWorkflowRun } from '../src/v2/controller-runtime.mjs';
import { selectAuthoritativeSourceWorkflowRun, selectCheckForWorkflowRun } from '../src/v2/ci-evidence-correlation.mjs';
import { parseTrustedJsonEnvelope, selectExistingPullRequest, selectTrustedMarkerComment, trustedCommentAuthorForRepository, validateControllerRunProvenance } from '../src/v2/controller-provenance.mjs';
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
import { attachLegacyAdoptionAuditRun, legacyAdoptionComment, parseLegacyAdoptionEnvelope, reconcileLegacyAdoption, recordLegacyAdoptionAuditResult, refreezeLegacyAdoption, reserveLegacyAdoptionAudit, validateLegacyAdoptionControllerRun } from '../src/v2/legacy-adoption.mjs';
import { buildClassifierPackage } from '../src/v2/classifier-distribution.mjs';
import { fetchImmutableCompareEvidence } from '../src/v2/github-audit-evidence.mjs';
import { resolveCheckedOutControlPlaneHeadSha } from './guard-delivery-v2-reentry.mjs';

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

export function shouldRearmFailedTechnicalHygiene({
  nextAction,
  runConclusion,
  runHeadSha,
  currentControllerSha
} = {}) {
  const previousSha = String(runHeadSha ?? '').trim().toLowerCase();
  const currentSha = String(currentControllerSha ?? '').trim().toLowerCase();

  return (
    String(nextAction ?? '') === 'technical-hygiene-worker-failed' &&
    String(runConclusion ?? '') !== 'success' &&
    /^[0-9a-f]{40}$/.test(previousSha) &&
    /^[0-9a-f]{40}$/.test(currentSha) &&
    previousSha !== currentSha
  );
}

const RECOVERABLE_UNKNOWN_HYGIENE_CODES = new Set([
  'VALIDATION_TOOLCHAIN_MISSING',
  'SAFEOUTPUT_TOOL_MISSING',
  'GIT_TOOL_MISSING',
  'NODE_TOOL_MISSING',
  'NPM_TOOL_MISSING',
  'PNPM_TOOL_MISSING',

  // Historical evidence vocabulary emitted by earlier hygiene workers.
  // These aliases remain protected by the existing control-plane SHA
  // change guard, so they cannot create a same-SHA automatic retry loop.
  'SAFEOUTPUTS_UNAVAILABLE',
  'LOCAL_DEPENDENCIES_UNAVAILABLE'
]);

export function shouldRearmUnknownTechnicalHygiene({
  technicalHygiene,
  runConclusion,
  runHeadSha,
  currentControllerSha
} = {}) {
  const previousSha = String(runHeadSha ?? '').trim().toLowerCase();
  const currentSha = String(currentControllerSha ?? '').trim().toLowerCase();
  const result = String(technicalHygiene?.result ?? '')
    .trim()
    .toUpperCase();

  const missingEvidence = Array.isArray(technicalHygiene?.missingEvidence)
    ? technicalHygiene.missingEvidence
    : [];

  const materialMissingEvidence = missingEvidence.filter(
    (item) => item?.material === true
  );

  const hasOnlyRecoverableToolchainMaterialEvidence =
    materialMissingEvidence.length > 0 &&
    materialMissingEvidence.every((item) =>
      RECOVERABLE_UNKNOWN_HYGIENE_CODES.has(
        String(item?.code ?? '').trim().toUpperCase()
      )
    );

  return (
    result === 'UNKNOWN' &&
    String(runConclusion ?? '').trim().toLowerCase() === 'success' &&
    hasOnlyRecoverableToolchainMaterialEvidence &&
    /^[0-9a-f]{40}$/.test(previousSha) &&
    /^[0-9a-f]{40}$/.test(currentSha) &&
    previousSha !== currentSha
  );
}

const TECHNICAL_HYGIENE_RESUME_ACTIONS = new Set([
  'dispatch-technical-hygiene',
  'observe-technical-hygiene',
  'technical-hygiene-worker-failed'
]);

export function resumeEntryNextAction({
  stateStatus,
  controllerNextAction
} = {}) {
  const persistedAction = String(controllerNextAction ?? '').trim();

  if (TECHNICAL_HYGIENE_RESUME_ACTIONS.has(persistedAction)) {
    return persistedAction;
  }

  return String(stateStatus ?? '').trim();
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
    // Reobserving a drifted material head is not a new V2 implementation.
    // Preserve exactly the attempt counters from the existing operational epoch.
    implementationAttempts: previousState?.implementationAttempts ?? fresh.implementationAttempts,
    auditAttempts: previousState?.auditAttempts ?? 0,
    auditRemediationAttempts: previousState?.auditRemediationAttempts ?? 0
  });
}

export function markExistingAuditInFlight(state) {
  if (state.status !== 'audit-pending' || state.auditAttempts < 1) throw new Error('existing audit requires audit-pending state with a reserved attempt');
  return Object.freeze({ ...state, auditInFlight: true });
}

export function shouldStartFreshAudit({ state, controller = {} } = {}) {
  if (state?.status !== 'audit-pending' || state.auditInFlight === true) return false;
  if (controller.auditRunId) return false;

  // A persisted nonce with an already consumed audit attempt means an
  // in-flight audit must be recovered instead of allocating another one.
  if (state.auditAttempts > 0 && controller.auditDispatchNonce) return false;

  // Covers both the first audit and a new audit after remediation published
  // a different material SHA. Historical auditAttempts belong to prior
  // candidates and do not represent an in-flight audit for the current SHA.
  return true;
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

export async function persistLegacyRefreeze({ envelope, pullRequest, comments, checkoutHeadSha, plan, classifier, runs, checks, targetPolicy, controller, observePullRequest, persist }) {
  let adoption = refreezeLegacyAdoption({ record: envelope.adoption, pullRequest, comments, checkoutHeadSha, plan, classifier, runs, checks, targetPolicy });
  // Observe again after evidence collection. No old green check survives a race.
  adoption = reconcileLegacyAdoption(adoption, await observePullRequest());
  await persist(legacyAdoptionComment(adoption, controller));
  return {
    schemaVersion: 1, status: 'legacy-adopted', phase: adoption.phase,
    repository: adoption.repository, issueNumber: adoption.issueNumber,
    pullRequestNumber: adoption.pullRequestNumber, headRef: adoption.headRef,
    materialHeadSha: adoption.materialHeadSha, nextAction: adoption.nextAction,
    attempts: adoption.attempts, providerCalls: 0, initialImplementationReserved: false,
    releaseReady: false, adoption
  };
}

export function auditProducerInputs({ state, controller = {}, provider, plan } = {}) {
  if (!state || typeof state !== 'object') throw new Error('audit producer state is required');

  const legacyEpoch = controller.adoption?.type === 'legacy-adopted-post-refreeze';
  const materialWorkerRunId = Number(controller.materialWorkerRunId ?? controller.workerRunId ?? 0);
  const materialProducerKnown = Number.isInteger(materialWorkerRunId) && materialWorkerRunId > 0;

  if (legacyEpoch && !materialProducerKnown) {
    return Object.freeze({
      implementation_attempt: '',
      implementer_provenance: 'legacy-unknown',
      implementer_provider: '',
      implementer_worker_identity: '',
      implementer_run_id: ''
    });
  }

  if (!materialProducerKnown) {
    throw new Error('known material producer requires persisted worker run identity');
  }

  const implementationAttempt = legacyEpoch
    ? Math.max(1, Number(state.auditRemediationAttempts ?? 0))
    : Number(state.implementationAttempts);

  if (!Number.isInteger(implementationAttempt) || implementationAttempt < 1) {
    throw new Error('known material producer requires a positive implementation attempt');
  }

  const workerProvider = String(controller.materialWorkerProvider ?? provider ?? '').trim().toLowerCase();
  const workerIdentity = String(controller.materialWorkerIdentity ?? plan?.implementation?.workflow ?? '').trim();

  if (!workerProvider || !workerIdentity) {
    throw new Error('known material producer identity is incomplete');
  }

  return Object.freeze({
    implementation_attempt: String(implementationAttempt),
    implementer_provenance: 'known',
    implementer_provider: workerProvider,
    implementer_worker_identity: workerIdentity,
    implementer_run_id: String(materialWorkerRunId)
  });
}

export function legacyTechnicalHygieneContext({
  materialHeadSha,
  baselineSha,
  profile
} = {}) {
  const material = String(materialHeadSha ?? '').trim().toLowerCase();
  const baseline = String(baselineSha ?? '').trim().toLowerCase();
  const risk = String(profile ?? '').trim().toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(material)) {
    throw new Error('legacy technical hygiene requires exact material SHA');
  }

  if (!/^[0-9a-f]{40}$/.test(baseline)) {
    throw new Error('legacy technical hygiene requires exact baseline SHA');
  }

  if (!['fast', 'standard', 'critical'].includes(risk)) {
    throw new Error('legacy technical hygiene requires a valid risk profile');
  }

  return JSON.stringify({
    kind: 'technical-hygiene-evidence-collection',
    evidenceOnly: true,
    materialSha: material,
    baselineSha: baseline,
    profile: risk,
    mutationAllowed: false
  });
}

async function mutateLegacyAdoptionCheckpoint({
  repository,
  prNumber,
  expectedCommentId,
  token,
  controller,
  mutate
}) {
  const currentComments = await listComments(repository, prNumber, token);
  const envelope = parseLegacyAdoptionEnvelope(currentComments, repository);

  if (!envelope) throw new Error('legacy adoption checkpoint disappeared');
  if (envelope.commentId !== expectedCommentId) {
    throw new Error('legacy adoption checkpoint identity changed');
  }

  const next = mutate(envelope.adoption);

  await patchJson(
    `https://api.github.com/repos/${repository}/issues/comments/${envelope.commentId}`,
    token,
    { body: legacyAdoptionComment(next, controller) }
  );

  return next;
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
  const actionsToken = requiredEnv('GITHUB_TOKEN');
  const controllerRunId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');
  const resultPath = process.env.CONTROLLER_RESULT_PATH || path.join(process.env.RUNNER_TEMP || '/tmp', 'delivery-v2-controller-result.json');
  const targetPolicy = await loadControllerTarget(targetRepository, baseBranch);
  const repositoryPolicy = await loadRepositoryRiskPolicy(targetRepository);

  let pullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
  if (!selectExistingPullRequest([pullRequest], { repository: targetRepository, issueNumber, baseBranch, trustedLogin: trustedCommentAuthorForRepository(targetRepository) })) {
    throw new Error('existing PR is not bound to requested issue');
  }

  let materialHeadSha = String(pullRequest.head.sha).toLowerCase();
  const expectedBaseSha = String(pullRequest.base.sha).toLowerCase();
  const trustedLogin = trustedCommentAuthorForRepository(targetRepository);
  const comments = await listComments(targetRepository, resumePr, targetReadToken);
  let stateEnvelope = parseStateComment(comments, trustedLogin);
  let changedPaths = stateEnvelope
    ? await fetchChangedPaths(targetRepository, resumePr, targetReadToken)
    : (await fetchImmutableCompareEvidence(targetRepository, expectedBaseSha, materialHeadSha, targetReadToken)).changedPaths;
  let plan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk, changedPaths, repositoryPolicy });
  let classifier;
  let latestCheck = null;
  let latestSourceRun = null;

  if (!stateEnvelope) {
    const envelope = parseLegacyAdoptionEnvelope(comments, targetRepository);
    if (!envelope) throw new Error('PR has neither canonical state nor a trusted adoption checkpoint');
    if (envelope.adoption.issueNumber !== issueNumber || envelope.adoption.baseRef !== baseBranch) throw new Error('adoption target mismatch');

    const priorRun = await api(
      `https://api.github.com/repos/${orchestratorRepository}/actions/runs/${positiveInteger(envelope.controller?.controllerRunId, 'adoption controllerRunId')}`,
      actionsToken
    );
    validateLegacyAdoptionControllerRun(envelope, priorRun, {
      orchestratorRepository,
      trustedRef: orchestratorRef
    });

    const checkout = requiredEnv('DELIVERY_V2_ADOPTED_CHECKOUT');
    const { stdout } = await promisify(execFile)(
      'git',
      ['-C', checkout, 'rev-parse', 'HEAD']
    );

    // Fingerprint the canonical runtime actually executing classification, not
    // a candidate-controlled lock file or the material commit identifier.
    const rootDir = fileURLToPath(new URL('../', import.meta.url));
    const controlPlane = await promisify(execFile)(
      'git',
      ['-C', rootDir, 'rev-parse', 'HEAD']
    );
    const sourceCommit = controlPlane.stdout.trim();

    const distribution = buildClassifierPackage({
      rootDir,
      sourceCommit,
      targetConfig: {
        schemaVersion: 1,
        repository: targetRepository,
        baseBranch,
        riskPolicy: repositoryPolicy
      }
    });

    classifier = {
      version: `${orchestratorRepository}@${sourceCommit}`,
      fingerprint: distribution.lock.canonicalClassifierFingerprint,
      policyFingerprint: distribution.lock.files['policy.json']
    };

    const sourceRun = await sourceWorkflowRunForHead({
      repository: targetRepository,
      sha: materialHeadSha,
      workflowName: targetPolicy.ciWorkflowName,
      token: targetReadToken
    });

    const checkRuns = await fetchCheckRuns(
      targetRepository,
      materialHeadSha,
      targetReadToken
    );

    const adoptionController = {
      controllerRunId,
      controllerRepository: orchestratorRepository,
      controllerRef: orchestratorRef,
      controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml'
    };

    const payload = await persistLegacyRefreeze({
      envelope,
      pullRequest,
      comments,
      checkoutHeadSha: stdout.trim(),
      plan,
      classifier: { ...classifier, subjectSha: materialHeadSha },
      runs: sourceRun ? [sourceRun] : [],
      checks: checkRuns,
      targetPolicy,
      controller: adoptionController,
      observePullRequest: () => fetchPullRequest(
        targetRepository,
        resumePr,
        targetReadToken
      ),
      persist: (body) => patchJson(
        `https://api.github.com/repos/${targetRepository}/issues/comments/${envelope.commentId}`,
        requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN'),
        { body }
      )
    });

    const targetWriteToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');

    if (payload.phase !== 'post-write-refreeze') {
      await publishReleaseStatus({
        repository: targetRepository,
        sha: payload.materialHeadSha,
        context: targetPolicy.finalStatusName,
        state: 'pending',
        description: 'Legacy PR adoption still requires trusted refreeze evidence',
        token: targetWriteToken
      });

      await writeFile(
        resultPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8'
      );
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }

    materialHeadSha = payload.materialHeadSha;
    latestSourceRun = sourceRun;

    if (!latestSourceRun) {
      throw new Error('post-write-refreeze requires authoritative source CI run');
    }

    latestCheck = selectCheckForWorkflowRun(checkRuns, {
      requiredStatusName: targetPolicy.requiredStatusName,
      workflowRunId: latestSourceRun.id
    });

    if (
      !latestCheck ||
      latestCheck.status !== 'completed' ||
      latestCheck.conclusion !== 'success'
    ) {
      throw new Error('post-write-refreeze requires exact-head terminal green CI');
    }

    let adoption = payload.adoption;
    let auditDispatchNonce = adoption.legacyAudit?.dispatchNonce ?? null;

    if (plan.audit.required) {
      auditDispatchNonce = auditDispatchNonce ?? createDispatchNonce();

      adoption = reserveLegacyAdoptionAudit(adoption, {
        dispatchNonce: auditDispatchNonce
      });

      await patchJson(
        `https://api.github.com/repos/${targetRepository}/issues/comments/${envelope.commentId}`,
        targetWriteToken,
        { body: legacyAdoptionComment(adoption, adoptionController) }
      );
    }

    const adoptedState = createAdoptedOperationalDelivery({
      plan,
      materialHeadSha,
      ciEvidence: {
        evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url
      }
    });

    await upsertStateComment({
      repository: targetRepository,
      prNumber: resumePr,
      state: adoptedState,
      identity: {
        issueNumber,
        pullRequestNumber: resumePr,
        baseRef: pullRequest.base.ref,
        baseSha: pullRequest.base.sha,
        headRef: pullRequest.head.ref,
        provider
      },
      classifier,
      latestCheck,
      latestSourceRun,
      token: targetWriteToken,
      extra: {
        controllerRunId,
        controllerRepository: orchestratorRepository,
        controllerRef: orchestratorRef,
        controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml',
        nextAction: adoptedState.status,
        auditRunId: adoption.legacyAudit?.runId ?? null,
        auditDispatchNonce,
        auditRequestFingerprint: adoption.legacyAudit?.requestFingerprint ?? null,
        materialWorkerRunId: null,
        materialWorkerIdentity: null,
        materialWorkerProvider: null,
        technicalHygiene: null,
        adoption: {
          type: 'legacy-adopted-post-refreeze',
          source: 'delivery-v2-legacy-adoption-checkpoint',
          checkpointCommentId: envelope.commentId,
          historicalAttempts: adoption.attempts,
          legacyAdoptionAuditAttempts: adoption.legacyAdoptionAuditAttempts,
          legacyAdoptionAuditMaxAttempts: adoption.legacyAdoptionAuditMaxAttempts,
          producerProvenance: 'legacy-unknown',
          adoptedHeadSha: adoption.adoption.adoptedHeadSha,
          operationalEpochHeadSha: adoption.materialHeadSha
        }
      }
    });

    await publishReleaseStatus({
      repository: targetRepository,
      sha: materialHeadSha,
      context: targetPolicy.finalStatusName,
      state: 'pending',
      description: 'Legacy PR refrozen; post-adoption V2 evaluation in progress',
      token: targetWriteToken,
      targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}`
    });

    const refreshedComments = await listComments(
      targetRepository,
      resumePr,
      targetReadToken
    );

    stateEnvelope = parseStateComment(refreshedComments, trustedLogin);

    if (!stateEnvelope) {
      throw new Error('failed to persist post-adoption operational state');
    }
  }
  classifier = await classifierIdentity(targetRepository, materialHeadSha, targetReadToken);
  if (stateEnvelope.persistent.issueNumber !== issueNumber) throw new Error('persisted state issue does not match requested issue');
  if (stateEnvelope.persistent.baseRef !== baseBranch) throw new Error('persisted state baseRef does not match requested base');
  if (stateEnvelope.persistent.provider !== provider) throw new Error('persisted state provider does not match requested provider');
  const resumeObservability = initializeResumeObservability(stateEnvelope.controller, { startedAtMs: resumeStartedAtMs });
  let observability = resumeObservability.observability;
  const observabilityHistoryComplete = resumeObservability.historyComplete;
  const priorControllerRunId = positiveInteger(stateEnvelope.controller?.controllerRunId, 'persisted controllerRunId');
  const priorControllerRun = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${priorControllerRunId}`, actionsToken);
  validateControllerRunProvenance(priorControllerRun, { orchestratorRepository, trustedRef: orchestratorRef });
  let state;
  let controller = {
    ...stateEnvelope.controller,
    ...(!String(pullRequest.title ?? '').startsWith('[delivery-v2] ') && !stateEnvelope.controller.adoption ? {
      adoption: {
        type: 'legacy-adopted', source: 'trusted-github-pr-and-persistent-state',
        repository: targetRepository, issueNumber, pullRequestNumber: resumePr,
        headRef: pullRequest.head.ref, baseRef: pullRequest.base.ref,
        adoptedHeadSha: materialHeadSha, adoptedBaseSha: expectedBaseSha,
        stateCommentId: stateEnvelope.commentId, priorControllerRunId
      }
    } : {}),
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
    if (!reconciled.staleStateDetected && controller.technicalHygiene) {
      let reusePersistedTechnicalHygiene = true;

      const persistedHygieneRunId = Number(
        controller.hygieneRunId ?? 0
      );

      if (
        String(controller.technicalHygiene?.result ?? '')
          .trim()
          .toUpperCase() === 'UNKNOWN' &&
        Number.isInteger(persistedHygieneRunId) &&
        persistedHygieneRunId > 0
      ) {
        const persistedHygieneRun = await api(
          `https://api.github.com/repos/${orchestratorRepository}/actions/runs/${persistedHygieneRunId}`,
          actionsToken
        );

        const currentControllerSha =
          resolveCheckedOutControlPlaneHeadSha();

        if (
          shouldRearmUnknownTechnicalHygiene({
            technicalHygiene: controller.technicalHygiene,
            runConclusion: persistedHygieneRun.conclusion,
            runHeadSha: persistedHygieneRun.head_sha,
            currentControllerSha
          })
        ) {
          const previousControllerSha = String(
            persistedHygieneRun.head_sha ?? ''
          ).trim().toLowerCase();

          controller = {
            ...controller,
            nextAction: 'dispatch-technical-hygiene',
            hygieneDispatchNonce: createDispatchNonce(),
            hygieneRunId: null,
            technicalHygiene: null,
            hygieneRecovery: {
              schemaVersion: 1,
              reason: 'control-plane-changed-after-unknown-technical-hygiene',
              previousRunId: persistedHygieneRun.id,
              previousControllerSha,
              currentControllerSha
            }
          };

          reusePersistedTechnicalHygiene = false;
        }
      }

      if (reusePersistedTechnicalHygiene) {
        state = applyOperationalEvent(state, {
          type: 'technical-hygiene-result',
          result: controller.technicalHygiene
        });
      }
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

  const targetWriteToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');

  const persist = async (extra = {}, stateOverride = state) => {
    controller = { ...controller, observability, observabilityHistoryComplete, ...extra };
    return upsertStateComment({
      repository: targetRepository,
      prNumber: resumePr,
      state: stateOverride,
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
  await persist({
    nextAction: resumeEntryNextAction({
      stateStatus: state.status,
      controllerNextAction: controller.nextAction
    })
  });

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
      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: technicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: resumePr, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken, authorizePromotion: async ({ phase, dispatchNonce, runId, promotedState }) => {
        await persist({
          nextAction: phase === 'observe'
            ? 'observe-technical-hygiene'
            : 'dispatch-technical-hygiene',
          hygieneDispatchNonce: dispatchNonce,
          hygieneRunId: runId
        }, promotedState);
      } });
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
      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: technicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: resumePr, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken, authorizePromotion: async ({ phase, dispatchNonce, runId, promotedState }) => {
        await persist({
          nextAction: phase === 'observe'
            ? 'observe-technical-hygiene'
            : 'dispatch-technical-hygiene',
          hygieneDispatchNonce: dispatchNonce,
          hygieneRunId: runId
        }, promotedState);
      } });
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

      const dispatchCurrentAudit = async (dispatchNonce) => {
        const sourceRun = latestSourceRun ?? await sourceWorkflowRunForHead({
          repository: targetRepository,
          sha: materialHeadSha,
          workflowName: targetPolicy.ciWorkflowName,
          token: targetReadToken
        });

        if (!sourceRun) {
          throw new Error('audit dispatch requires authoritative exact-head source CI');
        }

        return dispatchWorkflowAndResolveRun({
          repository: orchestratorRepository,
          workflow: 'delivery-v2-audit.yml',
          ref: orchestratorRef,
          token: actionsToken,
          kind: 'audit',
          dispatchNonce,
          inputs: {
            target_repository: targetRepository,
            target_issue: String(issueNumber),
            target_pr: String(resumePr),
            risk_profile: state.riskProfile,
            source_workflow_run_id: String(sourceRun.id),
            source_workflow_name: targetPolicy.ciWorkflowName,
            source_workflow_path: targetPolicy.ciWorkflowPath,
            ...auditProducerInputs({
              state,
              controller,
              provider,
              plan
            }),
            prior_findings_json: JSON.stringify(controller.priorFindings ?? [])
          }
        });
      };

      if (controller.auditRunId) {
        state = markExistingAuditInFlight(state);

        auditRun = await waitWorkflowRun(
          orchestratorRepository,
          Number(controller.auditRunId),
          actionsToken
        );
      } else if (state.auditAttempts > 0 && controller.auditDispatchNonce) {
        state = markExistingAuditInFlight(state);

        const recovered = selectCorrelatedWorkflowRun(
          await listWorkflowRuns(
            orchestratorRepository,
            'delivery-v2-audit.yml',
            actionsToken
          ),
          {
            kind: 'audit',
            nonce: controller.auditDispatchNonce,
            ref: orchestratorRef
          }
        );

        if (recovered) {
          auditRun = recovered;
        } else if (controller.nextAction === 'dispatch-audit') {
          // Crash-safe window:
          // nonce + reserved attempt were persisted before dispatch.
          // Reuse the SAME nonce instead of allocating another audit.
          auditRun = await dispatchCurrentAudit(controller.auditDispatchNonce);
        } else {
          throw new Error(
            'cannot safely recover in-flight audit by dispatch nonce; refusing duplicate audit'
          );
        }

        await persist({
          nextAction: 'observe-audit',
          auditRunId: auditRun.id,
          auditDispatchNonce: controller.auditDispatchNonce
        });

        auditRun = await waitWorkflowRun(
          orchestratorRepository,
          auditRun.id,
          actionsToken
        );
      } else if (shouldStartFreshAudit({ state, controller })) {
        state = applyOperationalEvent(state, { type: 'start-audit' });

        if (state.status === 'escalated') {
          await persist({
            nextAction: 'human-escalation',
            auditRunId: null,
            auditDispatchNonce: null
          });
          continue;
        }

        const auditDispatchNonce =
          controller.auditDispatchNonce ?? createDispatchNonce();

        await persist({
          nextAction: 'dispatch-audit',
          auditRunId: null,
          auditDispatchNonce
        });

        // The process may have crashed after a workflow_dispatch but before the
        // run id was persisted. Resolve by nonce before issuing any new dispatch.
        const recovered = selectCorrelatedWorkflowRun(
          await listWorkflowRuns(
            orchestratorRepository,
            'delivery-v2-audit.yml',
            actionsToken
          ),
          {
            kind: 'audit',
            nonce: auditDispatchNonce,
            ref: orchestratorRef
          }
        );

        auditRun = recovered ?? await dispatchCurrentAudit(auditDispatchNonce);

        await persist({
          nextAction: 'observe-audit',
          auditRunId: auditRun.id,
          auditDispatchNonce
        });

        auditRun = await waitWorkflowRun(
          orchestratorRepository,
          auditRun.id,
          actionsToken
        );
      } else {
        throw new Error(
          'audit-pending state has inconsistent persisted audit identity'
        );
      }

      const isInitialLegacyAudit =
        controller.adoption?.type === 'legacy-adopted-post-refreeze' &&
        controller.adoption?.producerProvenance === 'legacy-unknown' &&
        !controller.materialWorkerRunId &&
        state.auditAttempts === 1;

      if (isInitialLegacyAudit) {
        await mutateLegacyAdoptionCheckpoint({
          repository: targetRepository,
          prNumber: resumePr,
          expectedCommentId: Number(controller.adoption.checkpointCommentId),
          token: targetWriteToken,
          controller: {
            controllerRunId,
            controllerRepository: orchestratorRepository,
            controllerRef: orchestratorRef,
            controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml'
          },
          mutate: (record) => attachLegacyAdoptionAuditRun(record, {
            dispatchNonce: controller.auditDispatchNonce,
            runId: auditRun.id
          })
        });
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
      if (isInitialLegacyAudit) {
        await mutateLegacyAdoptionCheckpoint({
          repository: targetRepository,
          prNumber: resumePr,
          expectedCommentId: Number(controller.adoption.checkpointCommentId),
          token: targetWriteToken,
          controller: {
            controllerRunId,
            controllerRepository: orchestratorRepository,
            controllerRef: orchestratorRef,
            controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml'
          },
          mutate: (record) => recordLegacyAdoptionAuditResult(record, {
            runId: auditRun.id,
            candidateSha: materialHeadSha,
            decision: result.decision,
            requestFingerprint: result.requestFingerprint,
            evidenceRef: auditRun.html_url,
            findings: result.findings
          })
        });
      }

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

    // Do not collect hygiene or release evidence against an unrefrozen head.
    releaseIdentityFromPullRequest(pullRequest, {
      materialHeadSha: state.materialHeadSha,
      baseSha: expectedBaseSha
    });

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

    if (
      controller.adoption?.type === 'legacy-adopted-post-refreeze' &&
      !state.technicalHygiene
    ) {
      let hygieneDispatchNonce =
        String(controller.hygieneDispatchNonce ?? '').trim();

      if (!hygieneDispatchNonce) {
        hygieneDispatchNonce = createDispatchNonce();

        await persist({
          nextAction: 'dispatch-technical-hygiene',
          hygieneDispatchNonce,
          hygieneRunId: null
        });
      }

      const hygieneContext = legacyTechnicalHygieneContext({
        materialHeadSha,
        baselineSha: expectedBaseSha,
        profile: state.riskProfile
      });

      let hygieneRun;
      const persistedHygieneRunId = Number(controller.hygieneRunId ?? 0);

      if (
        Number.isInteger(persistedHygieneRunId) &&
        persistedHygieneRunId > 0
      ) {
        hygieneRun = await waitWorkflowRun(
          orchestratorRepository,
          persistedHygieneRunId,
          actionsToken
        );

        const currentControllerSha =
          resolveCheckedOutControlPlaneHeadSha();

        if (
          shouldRearmFailedTechnicalHygiene({
            nextAction: controller.nextAction,
            runConclusion: hygieneRun.conclusion,
            runHeadSha: hygieneRun.head_sha,
            currentControllerSha
          })
        ) {
          const previousHygieneRunId = hygieneRun.id;
          const previousControllerSha = String(
            hygieneRun.head_sha ?? ''
          ).trim().toLowerCase();

          hygieneDispatchNonce = createDispatchNonce();

          await persist({
            nextAction: 'dispatch-technical-hygiene',
            hygieneDispatchNonce,
            hygieneRunId: null,
            hygieneRecovery: {
              schemaVersion: 1,
              reason: 'control-plane-changed-after-technical-hygiene-failure',
              previousRunId: previousHygieneRunId,
              previousControllerSha,
              currentControllerSha
            }
          });

          hygieneRun = null;
        }
      }

      if (!hygieneRun) {
        const recovered = selectCorrelatedWorkflowRun(
          await listWorkflowRuns(
            orchestratorRepository,
            plan.implementation.workflow,
            actionsToken
          ),
          {
            kind: 'worker',
            nonce: hygieneDispatchNonce,
            ref: orchestratorRef
          }
        );

        hygieneRun = recovered;

        if (!hygieneRun) {
          if (
            controller.nextAction !== 'dispatch-technical-hygiene' ||
            controller.hygieneDispatchNonce !== hygieneDispatchNonce
          ) {
            throw new Error(
              'cannot safely recover technical hygiene evidence dispatch; refusing duplicate worker'
            );
          }

          hygieneRun = await dispatchWorker({
            orchestratorRepository,
            orchestratorRef,
            plan,
            controllerRunId,
            targetRepository,
            issueNumber,
            baseBranch,
            targetRef: materialHeadSha,
            targetPr: resumePr,
            remediationContext: hygieneContext,
            token: actionsToken,
            dispatchNonce: hygieneDispatchNonce
          });
        }

        await persist({
          nextAction: 'observe-technical-hygiene',
          hygieneDispatchNonce,
          hygieneRunId: hygieneRun.id
        });

        hygieneRun = await waitWorkflowRun(
          orchestratorRepository,
          hygieneRun.id,
          actionsToken
        );
      }

      if (hygieneRun.conclusion !== 'success') {
        await persist({
          nextAction: 'technical-hygiene-worker-failed',
          hygieneDispatchNonce,
          hygieneRunId: hygieneRun.id
        });

        throw new Error(
          `technical hygiene evidence worker failed: ${hygieneRun.html_url}`
        );
      }

      await recordWorkerUsage(hygieneRun);

      const postHygienePullRequest = await fetchPullRequest(
        targetRepository,
        resumePr,
        targetReadToken
      );

      // Evidence-only means exactly that: no material mutation is accepted.
      releaseIdentityFromPullRequest(postHygienePullRequest, {
        materialHeadSha,
        baseSha: expectedBaseSha
      });

      const technicalHygiene =
        await downloadGhAwTechnicalHygieneArtifact({
          repository: orchestratorRepository,
          runId: hygieneRun.id,
          token: actionsToken,
          baselineSha: expectedBaseSha,
          materialSha: materialHeadSha,
          previousMaterialSha: null,
          profile: state.riskProfile
        });

      state = applyOperationalEvent(state, {
        type: 'technical-hygiene-result',
        result: technicalHygiene
      });

      await persist({
        nextAction: 'evaluate-release-gate',
        hygieneDispatchNonce,
        hygieneRunId: hygieneRun.id,
        technicalHygiene: state.technicalHygiene
      });

      if (
        !['PASS', 'PASS_WITH_DEBT'].includes(
          state.technicalHygiene?.result
        )
      ) {
        await publishReleaseStatus({
          repository: targetRepository,
          sha: materialHeadSha,
          context: targetPolicy.finalStatusName,
          state: 'failure',
          description: `Delivery V2 technical hygiene ${state.technicalHygiene?.result ?? 'UNKNOWN'}`,
          token: targetWriteToken,
          targetUrl: hygieneRun.html_url
        });

        throw new Error(
          `legacy adoption technical hygiene did not pass: ${state.technicalHygiene?.result ?? 'UNKNOWN'}`
        );
      }
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
