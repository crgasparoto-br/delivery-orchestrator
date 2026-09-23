#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const BOOTSTRAP_MARKER = '<!-- delivery-v2-bootstrap-state -->';
const STATE_MARKER = '<!-- delivery-v2-state -->';
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const POLL_MS = Number(process.env.DELIVERY_V2_WORKER_AUTH_POLL_MS || 1000);
const MAX_WAIT_MS = Number(process.env.DELIVERY_V2_WORKER_AUTH_TIMEOUT_MS || 45000);

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalString(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubHeaders(token, userAgent = 'delivery-v2-worker-authorization') {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requiredString(token, 'token')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent
  };
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  return response.json();
}

function trustedOwner(repository) {
  return requiredString(repository, 'repository').split('/')[0].toLowerCase();
}

export function expectedWorkerWorkflow(provider, riskProfile) {
  const providerName = requiredString(provider, 'provider').toLowerCase();
  const risk = requiredString(riskProfile, 'riskProfile').toLowerCase();
  if (!['copilot', 'codex', 'claude'].includes(providerName)) throw new Error(`unsupported worker provider: ${providerName}`);
  if (!['fast', 'standard', 'critical'].includes(risk)) throw new Error(`unsupported worker risk: ${risk}`);
  return `delivery-v2-worker-${providerName}-${risk}.lock.yml`;
}

export function workflowFileFromRef(workflowRef) {
  const match = requiredString(workflowRef, 'GITHUB_WORKFLOW_REF').match(/\/\.github\/workflows\/([^@]+)@/);
  if (!match) throw new Error('cannot derive current worker workflow path');
  return match[1];
}

export function parseTrustedMarkerEnvelope(comments, { marker, label, repository } = {}) {
  if (!Array.isArray(comments)) throw new Error('comments must be an array');
  const expectedMarker = requiredString(marker, 'marker');
  const expectedLabel = requiredString(label, 'label');
  const owner = trustedOwner(repository);
  const matching = comments.filter((comment) => String(comment?.body ?? '').startsWith(expectedMarker));
  const untrusted = matching.filter((comment) => {
    const login = String(comment?.user?.login ?? '').toLowerCase();
    const association = String(comment?.author_association ?? '').toUpperCase();
    return login !== owner || (association && !TRUSTED_ASSOCIATIONS.has(association));
  });
  if (untrusted.length) throw new Error(`untrusted ${expectedLabel} marker comment found`);
  if (matching.length === 0) return null;
  if (matching.length > 1) throw new Error(`multiple ${expectedLabel} marker comments found`);
  const fenced = String(matching[0].body ?? '').match(/```json\s*([\s\S]*?)\s*```/);
  if (!fenced) throw new Error(`${expectedLabel} marker is missing JSON envelope`);
  return JSON.parse(fenced[1]);
}

export function validateControllerRun(run, { controllerRunId, targetRepository, targetIssue, defaultBranch } = {}) {
  const expectedId = requiredPositiveInteger(controllerRunId, 'controllerRunId');
  if (Number(run?.id) !== expectedId) throw new Error('controller run id mismatch');
  if (String(run?.path ?? '') !== '.github/workflows/delivery-v2-dispatch.yml') throw new Error('untrusted controller workflow path');
  if (String(run?.event ?? '') !== 'workflow_dispatch') throw new Error('untrusted controller event');
  if (String(run?.head_branch ?? '') !== requiredString(defaultBranch, 'defaultBranch')) throw new Error('untrusted controller ref');
  if (!['queued', 'in_progress'].includes(String(run?.status ?? ''))) throw new Error('controller run is not live');
  const expectedTitle = `Delivery V2 controller ${requiredString(targetRepository, 'targetRepository')} #${requiredPositiveInteger(targetIssue, 'targetIssue')}`;
  if (String(run?.display_title ?? '') !== expectedTitle) throw new Error('controller target identity mismatch');
  return true;
}

export function validateCurrentWorkerRun(run, { currentRunId, expectedWorkflow, dispatchNonce, defaultBranch } = {}) {
  const runId = requiredPositiveInteger(currentRunId, 'currentRunId');
  const workflow = requiredString(expectedWorkflow, 'expectedWorkflow');
  const nonce = requiredString(dispatchNonce, 'dispatchNonce');
  if (Number(run?.id) !== runId) throw new Error('worker run id mismatch');
  if (String(run?.path ?? '') !== `.github/workflows/${workflow}`) throw new Error('worker workflow identity mismatch');
  if (String(run?.event ?? '') !== 'workflow_dispatch') throw new Error('worker event mismatch');
  if (String(run?.head_branch ?? '') !== requiredString(defaultBranch, 'defaultBranch')) throw new Error('worker ref mismatch');
  if (String(run?.display_title ?? '') !== `Delivery V2 worker ${nonce}`) throw new Error('worker dispatch nonce mismatch');
  return true;
}

function validateSharedIdentity({ repository, issueNumber, baseBranch, provider, model = null, riskProfile, dispatchNonce, expectedWorkflow }, actual) {
  if (String(actual.repository ?? '') !== repository) throw new Error('authorization repository mismatch');
  if (Number(actual.issueNumber) !== issueNumber) throw new Error('authorization issue mismatch');
  if (String(actual.baseBranch ?? actual.baseRef ?? '') !== baseBranch) throw new Error('authorization base mismatch');
  if (String(actual.provider ?? '').toLowerCase() !== provider) throw new Error('authorization provider mismatch');
  if (model != null && String(actual.model ?? '') !== model) throw new Error('authorization model mismatch');
  if (String(actual.effectiveRisk ?? '').toLowerCase() !== riskProfile) throw new Error('authorization risk mismatch');
  if (String(actual.dispatchNonce ?? actual.workerDispatchNonce ?? '') !== dispatchNonce) throw new Error('authorization nonce mismatch');
  const workflow = String(actual.workerWorkflow ?? actual.workerIdentity ?? '');
  if (workflow && workflow !== expectedWorkflow) throw new Error('authorization worker workflow mismatch');
}

export function validateAuthorizationEnvelope({
  envelope,
  targetRepository,
  targetIssue,
  targetPr,
  targetRef,
  baseBranch,
  provider,
  model = null,
  riskProfile,
  dispatchNonce,
  controllerRunId,
  currentRunId,
  expectedWorkflow
} = {}) {
  const repository = requiredString(targetRepository, 'targetRepository');
  const issueNumber = requiredPositiveInteger(targetIssue, 'targetIssue');
  const base = requiredString(baseBranch, 'baseBranch');
  const providerName = requiredString(provider, 'provider').toLowerCase();
  const modelName = optionalString(model);
  const risk = requiredString(riskProfile, 'riskProfile').toLowerCase();
  const nonce = requiredString(dispatchNonce, 'dispatchNonce');
  const controllerId = requiredPositiveInteger(controllerRunId, 'controllerRunId');
  const runId = requiredPositiveInteger(currentRunId, 'currentRunId');
  const workflow = requiredString(expectedWorkflow, 'expectedWorkflow');
  const pr = String(targetPr ?? '').trim();

  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') throw new Error('authorization envelope is required');

  if (!pr) {
    if (Number(envelope.controllerRunId) !== controllerId) throw new Error('bootstrap controller run mismatch');
    if (String(envelope.status ?? '') !== 'reserved-initial-attempt') throw new Error('bootstrap lease is not active');
    validateSharedIdentity({ repository, issueNumber, baseBranch: base, provider: providerName, model: modelName, riskProfile: risk, dispatchNonce: nonce, expectedWorkflow: workflow }, envelope);
    if (String(targetRef ?? '') !== base) throw new Error('initial worker target_ref must equal authorized base branch');
    if (String(envelope.workerWorkflow ?? '') !== workflow) throw new Error('bootstrap worker workflow mismatch');
    return Object.freeze({ mode: 'initial', workerRunId: runId, controllerRunId: controllerId });
  }

  const prNumber = requiredPositiveInteger(pr, 'targetPr');
  const persistent = envelope.persistent;
  const controller = envelope.controller;
  if (!persistent || !controller) throw new Error('PR worker authorization requires persistent state and controller metadata');
  if (Number(controller.controllerRunId) !== controllerId) throw new Error('PR worker controller run mismatch');

  const nextAction = String(controller.nextAction ?? '');
  let mode;
  let authorizedRunId;
  let authorizedNonce;

  if (
    nextAction === 'observe-remediation' ||
    nextAction === 'observe-remediation-recovery'
  ) {
    mode = 'remediation';
    authorizedRunId = controller.workerRunId;
    authorizedNonce = controller.workerDispatchNonce;
  } else if (nextAction === 'observe-technical-hygiene') {
    mode = 'technical-hygiene';
    authorizedRunId = controller.hygieneRunId;
    authorizedNonce = controller.hygieneDispatchNonce;
  } else {
    throw new Error('PR worker is not the active authorized action');
  }

  if (Number(authorizedRunId) !== runId) throw new Error(`${mode} worker run mismatch`);
  if (Number(persistent.issueNumber) !== issueNumber) throw new Error('persistent issue mismatch');
  if (Number(persistent.pullRequestNumber) !== prNumber) throw new Error('persistent PR mismatch');
  if (String(persistent.repository ?? '') !== repository) throw new Error('persistent repository mismatch');
  if (String(persistent.baseRef ?? '') !== base) throw new Error('persistent base mismatch');
  if (String(persistent.provider ?? '').toLowerCase() !== providerName) throw new Error('persistent provider mismatch');
  if (modelName != null && String(persistent.model ?? '') !== modelName) throw new Error('persistent model mismatch');
  if (String(persistent.effectiveRisk ?? '').toLowerCase() !== risk) throw new Error('persistent risk mismatch');
  if (String(persistent.materialHeadSha ?? '').toLowerCase() !== String(targetRef ?? '').toLowerCase()) throw new Error('PR worker target_ref mismatch');
  if (String(authorizedNonce ?? '') !== nonce) throw new Error(`${mode} nonce mismatch`);

  return Object.freeze({
    mode,
    workerRunId: runId,
    controllerRunId: controllerId,
    pullRequestNumber: prNumber
  });
}

async function listComments(repository, issueNumber, token) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`, token);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function listWorkerRuns(repository, workflow, token) {
  const payload = await fetchJson(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100`, token);
  return payload.workflow_runs ?? [];
}

export function validateUniqueCorrelatedWorkerRun(runs, { currentRunId, dispatchNonce, defaultBranch } = {}) {
  if (!Array.isArray(runs)) throw new Error('workflow runs must be an array');
  const runId = requiredPositiveInteger(currentRunId, 'currentRunId');
  const title = `Delivery V2 worker ${requiredString(dispatchNonce, 'dispatchNonce')}`;
  const branch = requiredString(defaultBranch, 'defaultBranch');
  const matches = runs.filter((run) => String(run?.event ?? '') === 'workflow_dispatch' && String(run?.display_title ?? '') === title && String(run?.head_branch ?? '') === branch);
  if (matches.length !== 1) throw new Error(`worker authorization requires exactly one correlated run, found ${matches.length}`);
  if (Number(matches[0].id) !== runId) throw new Error('current worker is not the uniquely correlated authorized run');
  return true;
}

export async function main() {
  const orchestratorRepository = requiredString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const currentRunId = requiredPositiveInteger(process.env.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const controllerRunId = requiredPositiveInteger(process.env.CONTROLLER_RUN_ID, 'CONTROLLER_RUN_ID');
  const targetRepository = requiredString(process.env.TARGET_REPOSITORY, 'TARGET_REPOSITORY');
  const targetIssue = requiredPositiveInteger(process.env.TARGET_ISSUE, 'TARGET_ISSUE');
  const targetPr = String(process.env.TARGET_PR ?? '').trim();
  const targetRef = requiredString(process.env.TARGET_REF, 'TARGET_REF');
  const baseBranch = requiredString(process.env.BASE_BRANCH, 'BASE_BRANCH');
  const dispatchNonce = requiredString(process.env.DISPATCH_NONCE, 'DISPATCH_NONCE');
  const provider = requiredString(process.env.EXPECTED_PROVIDER, 'EXPECTED_PROVIDER').toLowerCase();
  const model = requiredString(process.env.EXPECTED_MODEL, 'EXPECTED_MODEL');
  const riskProfile = requiredString(process.env.EXPECTED_RISK, 'EXPECTED_RISK').toLowerCase();
  const defaultBranch = requiredString(process.env.DEFAULT_BRANCH, 'DEFAULT_BRANCH');
  const actionsToken = requiredString(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN');
  const targetReadToken = requiredString(process.env.DELIVERY_GITHUB_READ_TOKEN, 'DELIVERY_GITHUB_READ_TOKEN');
  const expectedWorkflow = expectedWorkerWorkflow(provider, riskProfile);
  if (workflowFileFromRef(process.env.GITHUB_WORKFLOW_REF) !== expectedWorkflow) throw new Error('current workflow file does not match provider/risk authorization');

  const [controllerRun, currentRun] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${controllerRunId}`, actionsToken),
    fetchJson(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${currentRunId}`, actionsToken)
  ]);
  validateControllerRun(controllerRun, { controllerRunId, targetRepository, targetIssue, defaultBranch });
  validateCurrentWorkerRun(currentRun, { currentRunId, expectedWorkflow, dispatchNonce, defaultBranch });

  const commentTarget = targetPr ? requiredPositiveInteger(targetPr, 'TARGET_PR') : targetIssue;
  const marker = targetPr ? STATE_MARKER : BOOTSTRAP_MARKER;
  const label = targetPr ? 'Delivery V2 state' : 'Delivery V2 bootstrap state';
  const deadline = Date.now() + MAX_WAIT_MS;
  let authorization;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const comments = await listComments(targetRepository, commentTarget, targetReadToken);
      const envelope = parseTrustedMarkerEnvelope(comments, { marker, label, repository: targetRepository });
      if (!envelope) throw new Error(`${label} authorization marker not found`);
      authorization = validateAuthorizationEnvelope({
        envelope,
        targetRepository,
        targetIssue,
        targetPr,
        targetRef,
        baseBranch,
        provider,
        model,
        riskProfile,
        dispatchNonce,
        controllerRunId,
        currentRunId,
        expectedWorkflow
      });
      break;
    } catch (error) {
      lastError = error;
      if (!targetPr) break;
      await sleep(POLL_MS);
    }
  }
  if (!authorization) throw lastError ?? new Error('worker authorization was not observed within bounded timeout');

  const runs = await listWorkerRuns(orchestratorRepository, expectedWorkflow, actionsToken);
  validateUniqueCorrelatedWorkerRun(runs, { currentRunId, dispatchNonce, defaultBranch });
  process.stdout.write(`${JSON.stringify({ authorized: true, ...authorization, provider, model, riskProfile, expectedWorkflow })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
