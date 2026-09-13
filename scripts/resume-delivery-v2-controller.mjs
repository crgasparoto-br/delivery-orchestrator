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
import { ciFailureClassForConclusion, createDispatchNonce, loadAuthoritativeAuditResult, publishReleaseStatus, releaseIdentityFromPullRequest, selectCorrelatedWorkflowRun } from '../src/v2/controller-runtime.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const AUDIT_MARKER = '<!-- delivery-v2-independent-audit -->';
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
  if (target.baseBranch !== baseBranch) throw new Error(`base branch ${baseBranch} does not match configured ${target.baseBranch}`);
  return Object.freeze(target);
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

function parseStateComment(comments) {
  const matching = comments.filter((comment) => String(comment.body ?? '').startsWith(STATE_MARKER));
  if (matching.length > 1) throw new Error('multiple Delivery V2 state comments found; refusing ambiguous resume');
  if (matching.length === 0) return null;
  const fenced = String(matching[0].body ?? '').match(/```json\s*([\s\S]*?)\s*```/);
  if (!fenced) throw new Error('Delivery V2 state comment is missing JSON envelope');
  const envelope = JSON.parse(fenced[1]);
  if (!envelope?.persistent) throw new Error('Delivery V2 state comment is missing persistent state');
  return Object.freeze({ commentId: matching[0].id, persistent: envelope.persistent, controller: envelope.controller ?? {} });
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
  const existing = comments.find((comment) => String(comment.body ?? '').startsWith(STATE_MARKER));
  if (existing) await patchJson(`https://api.github.com/repos/${repository}/issues/comments/${existing.id}`, token, { body });
  else await postJson(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments`, token, { body });
  return persistent;
}

async function fetchCheckRuns(repository, sha, token) {
  const payload = await api(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`, token);
  return payload.check_runs ?? [];
}

async function waitRequiredCheck({ repository, prNumber, sha, requiredStatusName, token }) {
  const deadline = Date.now() + MAX_STAGE_MS;
  while (Date.now() < deadline) {
    const pr = await fetchPullRequest(repository, prNumber, token);
    if (String(pr.head.sha).toLowerCase() !== sha.toLowerCase()) return { kind: 'head-drift', pullRequest: pr };
    const check = (await fetchCheckRuns(repository, sha, token)).find((item) => item.name === requiredStatusName);
    if (check?.status === 'completed') return { kind: 'check', check, pullRequest: pr };
    await sleep(POLL_MS);
  }
  throw new Error(`required check ${requiredStatusName} did not become terminal within bounded timeout`);
}

async function sourceWorkflowRunForHead({ repository, sha, workflowName, token }) {
  const payload = await api(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`, token);
  const matches = (payload.workflow_runs ?? []).filter((run) => run.name === workflowName && run.status === 'completed' && run.conclusion === 'success');
  if (matches.length === 0) throw new Error(`no terminal green source workflow ${workflowName} found for ${sha}`);
  return matches.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
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

async function dispatchWorker({ orchestratorRepository, orchestratorRef, plan, targetRepository, issueNumber, baseBranch, targetRef, targetPr, remediationContext, token, dispatchNonce = createDispatchNonce() }) {
  return dispatchWorkflowAndResolveRun({
    repository: orchestratorRepository,
    workflow: plan.implementation.workflow,
    ref: orchestratorRef,
    token,
    kind: 'worker',
    dispatchNonce,
    inputs: {
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

export async function main() {
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
  let providerCalls = 0;

  const stateEnvelope = parseStateComment(await listComments(targetRepository, resumePr, targetReadToken));
  let state;
  let controller = stateEnvelope?.controller ?? {};
  if (stateEnvelope) {
    const reconciled = reconcilePersistentState(stateEnvelope.persistent, {
      repository: targetRepository,
      pullRequestNumber: resumePr,
      headRef: String(pullRequest.head.ref),
      baseSha: String(pullRequest.base.sha),
      remoteHeadSha: materialHeadSha
    });
    state = operationalStateFromPersistent(reconciled.state);
    if (reconciled.staleStateDetected || ['queued', 'classified', 'ci-failed-remediable'].includes(state.status)) {
      state = rebuildCiPendingState({ plan, materialHeadSha, previousState: state });
      controller = { nextAction: 'observe-ci', resumedFrom: reconciled.nextAction };
    }
  } else {
    state = createOperationalDelivery({ plan, materialHeadSha });
    controller = { nextAction: 'observe-ci', recoveredMissingState: true };
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
    controller = { ...controller, ...extra };
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
      if (run.conclusion !== 'success') throw new Error(`persisted remediation worker failed: ${run.html_url}`);
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
      latestCheck = null;
      latestSourceRun = null;
      await persist({ nextAction: 'observe-ci', workerRunId: null });
      continue;
    }

    if (state.status === 'ci-pending') {
      const observed = await waitRequiredCheck({
        repository: targetRepository,
        prNumber: resumePr,
        sha: materialHeadSha,
        requiredStatusName: targetPolicy.requiredStatusName,
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
        await persist({ nextAction: 'observe-ci', reason: 'reconciled-head-drift' });
        continue;
      }

      latestCheck = observed.check;
      if (latestCheck.conclusion === 'success') {
        latestSourceRun = await sourceWorkflowRunForHead({ repository: targetRepository, sha: materialHeadSha, workflowName: targetPolicy.ciWorkflowName, token: targetReadToken });
        state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: materialHeadSha, conclusion: 'success', evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url } });
        await persist({ nextAction: state.status });
        continue;
      }

      const failureClass = ciFailureClassForConclusion(latestCheck.conclusion);
      state = applyOperationalEvent(state, {
        type: 'ci-result',
        result: {
          candidateSha: materialHeadSha,
          conclusion: 'failure',
          failureClass,
          cause: `${latestCheck.name}:${latestCheck.conclusion}`,
          evidenceRef: latestCheck.details_url ?? `github:check:${latestCheck.id}`
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
        targetRepository,
        issueNumber,
        baseBranch,
        targetRef: beforeSha,
        targetPr: resumePr,
        remediationContext: JSON.stringify(remediation),
        token: actionsToken,
        dispatchNonce: workerDispatchNonce
      });
      providerCalls += 1;
      await persist({ nextAction: 'observe-remediation', workerRunId: worker.id, workerDispatchNonce });
      worker = await waitWorkflowRun(orchestratorRepository, worker.id, actionsToken);
      if (worker.conclusion !== 'success') throw new Error(`remediation worker failed: ${worker.html_url}`);
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
      latestCheck = null;
      latestSourceRun = null;
      await persist({ nextAction: 'observe-ci', workerRunId: null });
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
            implementer_run_id: String(controller.materialWorkerRunId ?? controller.workerRunId)
          }
        });
        providerCalls += 1;
        await persist({ nextAction: 'observe-audit', auditRunId: auditRun.id, auditDispatchNonce });
        auditRun = await waitWorkflowRun(orchestratorRepository, auditRun.id, actionsToken);
      }
      if (auditRun.conclusion !== 'success') throw new Error(`independent audit workflow failed: ${auditRun.html_url}`);
      const sourceRun = latestSourceRun ?? await sourceWorkflowRunForHead({ repository: targetRepository, sha: materialHeadSha, workflowName: targetPolicy.ciWorkflowName, token: targetReadToken });
      const result = await auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber: resumePr, candidateSha: materialHeadSha, auditRun, sourceWorkflowRunId: sourceRun.id, token: actionsToken });
      state = applyOperationalEvent(state, { type: 'audit-result', result: { candidateSha: materialHeadSha, decision: result.decision, findings: result.findings, evidenceRef: auditRun.html_url } });
      await persist({ nextAction: state.status, auditRunId: auditRun.id, auditDispatchNonce: controller.auditDispatchNonce, auditRequestFingerprint: result.requestFingerprint });
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
    let audit = null;
    if (state.auditRequired) {
      const auditRunId = positiveInteger(controller.auditRunId, 'persisted auditRunId');
      const auditRun = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${auditRunId}`, actionsToken);
      const auditResult = await auditResultFromArtifact({ orchestratorRepository, orchestratorRef, targetRepository, issueNumber, prNumber: resumePr, candidateSha: materialHeadSha, auditRun, sourceWorkflowRunId: latestSourceRun.id, token: actionsToken });
      if (auditResult.decision !== 'approved') throw new Error('release gate requires approved authoritative audit');
      audit = { candidateSha: materialHeadSha, decision: 'approved', mode: state.auditMode, requestFingerprint: auditResult.requestFingerprint, evidenceRef: auditRun.html_url };
    }
    const finalPullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
    const releaseIdentity = releaseIdentityFromPullRequest(finalPullRequest, { materialHeadSha, baseSha: expectedBaseSha });
    const releaseInput = {
      schemaVersion: 1, repository: targetRepository, pullRequestNumber: resumePr, materialHeadSha, currentRemoteHeadSha: releaseIdentity.currentRemoteHeadSha,
      evidenceCollection: { materialHeadSha, remoteHeadSha: materialHeadSha, evidenceRef: `github:${targetRepository}#${resumePr}@${materialHeadSha}` },
      classifier: { subjectSha: materialHeadSha, profile: state.riskProfile, version: classifier.version, fingerprint: classifier.fingerprint, expectedFingerprint: classifier.fingerprint, evidenceRef: classifier.evidenceRef },
      mergePreview: releaseIdentity.mergePreview,
      checks: [{ name: latestCheck.name, required: true, subjectSha: materialHeadSha, status: latestCheck.status, conclusion: latestCheck.conclusion, workflowRunId: latestSourceRun.id, evidenceRef: latestCheck.details_url ?? latestSourceRun.html_url }],
      standardAuditRequired: targetPolicy.standardAuditRequired !== false, audit, unresolvedFindings: [], blockers: []
    };
    const release = evaluateOperationalRelease({ state, releaseInput });
    if (!release.readiness) throw new Error(`release gate did not become ready: ${release.reasons.join(', ')}`);
    await publishReleaseStatus({ repository: targetRepository, sha: materialHeadSha, context: targetPolicy.finalStatusName, state: 'success', description: 'Delivery V2 exact-head release gate approved', token: targetWriteToken, targetUrl: `https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}` });
    await persist({ nextAction: 'human-merge-policy', release });
  }

  pullRequest = await fetchPullRequest(targetRepository, resumePr, targetReadToken);
  const payload = {
    schemaVersion: 1,
    status: state.status,
    repository: targetRepository,
    issueNumber,
    pullRequestNumber: resumePr,
    materialHeadSha: String(pullRequest.head.sha).toLowerCase(),
    providerCalls,
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
