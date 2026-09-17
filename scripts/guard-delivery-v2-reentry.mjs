#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadV2Config } from '../src/v2/config.mjs';
import { createPersistentDeliveryState, reconcilePersistentState } from '../src/v2/persistent-state.mjs';
import { executionPolicyFor } from '../src/v2/execution-policy.mjs';
import { resolveProviderSelectionForRisk } from '../src/v2/provider-policy.mjs';
import { expectedDispatchTitle, selectCorrelatedWorkflowRun } from '../src/v2/controller-runtime.mjs';
import { parseTrustedJsonEnvelope, trustedCommentAuthorForRepository, validateControllerRunProvenance } from '../src/v2/controller-provenance.mjs';

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

async function api(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(token), ...(options.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  return response.json();
}

function closingPattern(issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
}

export function selectManagedPullRequest(pulls, { issueNumber, baseBranch, trustedLogin = null, repository = null } = {}) {
  if (!Array.isArray(pulls)) throw new Error('pulls must be an array');
  const closing = closingPattern(positiveInteger(issueNumber, 'issueNumber'));
  const base = String(baseBranch ?? '').trim();
  if (!base) throw new Error('baseBranch is required');
  const trusted = trustedLogin == null ? null : String(trustedLogin).toLowerCase();
  const expectedRepository = repository == null ? null : String(repository).toLowerCase();
  const candidates = pulls.filter((pr) =>
    String(pr?.state ?? 'open') === 'open'
    && String(pr?.base?.ref ?? '') === base
    && closing.test(String(pr?.body ?? ''))
    && String(pr?.head?.repo?.full_name ?? '').toLowerCase() !== ''
    && String(pr?.head?.repo?.full_name ?? '').toLowerCase() === String(pr?.base?.repo?.full_name ?? '').toLowerCase()
    && (!trusted || (String(pr?.user?.login ?? '').toLowerCase() === trusted && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(pr?.author_association ?? '').toUpperCase())))
    && (!expectedRepository || String(pr?.head?.repo?.full_name ?? '').toLowerCase() === expectedRepository)
  );
  if (candidates.length > 1) throw new Error(`multiple open adoptable PRs found for issue #${issueNumber}`);
  return candidates[0] ?? null;
}

export function createLegacyAdoptionEnvelope({ pullRequest, repository, issueNumber, provider, model = null, effectiveRisk = 'critical', controllerRunId } = {}) {
  const headSha = String(pullRequest?.head?.sha ?? '').toLowerCase();
  const baseSha = String(pullRequest?.base?.sha ?? '').toLowerCase();
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) throw new Error('legacy adoption requires exact head and base SHAs');
  return Object.freeze({
    persistent: createPersistentDeliveryState({
      repository, issueNumber, pullRequestNumber: positiveInteger(pullRequest.number, 'pullRequest.number'),
      baseRef: pullRequest.base.ref, baseSha, headRef: pullRequest.head.ref, materialHeadSha: headSha,
      effectiveRisk, classifier: { subjectSha: headSha, version: 'legacy-adoption-v1', fingerprint: headSha },
      provider, model, status: 'ci-pending', attempts: { implementation: 0, audit: 0, auditRemediation: 0 },
      evidenceRefs: [`github:pull/${pullRequest.number}@${headSha}`], lastReason: 'legacy-adopted'
    }),
    controller: Object.freeze({
      controllerRunId: positiveInteger(controllerRunId, 'controllerRunId'), nextAction: 'observe-ci',
      adoption: { type: 'legacy-adopted', source: 'github-open-pull-request', adoptedHeadSha: headSha }
    })
  });
}

export function terminalizeBootstrapLease(bootstrapLease, status) {
  if (!bootstrapLease || typeof bootstrapLease !== 'object') throw new Error('bootstrapLease is required');
  const terminal = { ...bootstrapLease, status: String(status) };
  delete terminal.commentId;
  return Object.freeze(terminal);
}

function parseJsonEnvelope(comments, marker, label, trustedLogin) {
  return parseTrustedJsonEnvelope(comments, { marker, label, trustedLogin });
}

export function parsePersistentStateEnvelope(comments, { trustedLogin } = {}) {
  const parsed = parseJsonEnvelope(comments, STATE_MARKER, 'Delivery V2 state', trustedLogin);
  if (!parsed) return null;
  if (!parsed.value?.persistent || typeof parsed.value.persistent !== 'object' || Array.isArray(parsed.value.persistent)) {
    throw new Error('Delivery V2 state comment is missing persistent state');
  }
  return Object.freeze({ commentId: parsed.commentId, persistent: parsed.value.persistent, controller: parsed.value.controller ?? null });
}

export function parseBootstrapLease(comments, { trustedLogin } = {}) {
  const parsed = parseJsonEnvelope(comments, BOOTSTRAP_MARKER, 'Delivery V2 bootstrap state', trustedLogin);
  if (!parsed) return null;
  const value = parsed.value;
  return Object.freeze({
    commentId: parsed.commentId,
    schemaVersion: value.schemaVersion,
    repository: String(value.repository ?? ''),
    issueNumber: Number(value.issueNumber),
    baseBranch: String(value.baseBranch ?? ''),
    provider: String(value.provider ?? '').toLowerCase(),
    model: value.model == null ? null : String(value.model),
    requestedRisk: String(value.requestedRisk ?? '').toLowerCase(),
    effectiveRisk: String(value.effectiveRisk ?? 'critical').toLowerCase(),
    implementationAttempts: Number(value.implementationAttempts),
    status: String(value.status ?? ''),
    controllerRunId: value.controllerRunId == null ? null : Number(value.controllerRunId),
    workerRunId: value.workerRunId == null ? null : Number(value.workerRunId),
    workerWorkflow: String(value.workerWorkflow ?? ''),
    dispatchNonce: String(value.dispatchNonce ?? '')
  });
}

function assertAiPolicyMatch({ persistedProvider, persistedModel = null, expectedProvider, expectedModel = null, label }) {
  if (String(persistedProvider ?? '').toLowerCase() !== String(expectedProvider ?? '').toLowerCase()) {
    throw new Error(`${label} provider does not match resolved delivery policy`);
  }
  if (persistedModel != null && expectedModel != null && String(persistedModel) !== String(expectedModel)) {
    throw new Error(`${label} model does not match resolved delivery policy`);
  }
}

function assertBootstrapRecoveryLease(bootstrapLease, { targetRepository, issueNumber, baseBranch, provider, model }) {
  if (bootstrapLease.schemaVersion !== 1) throw new Error('bootstrap recovery lease schemaVersion must be 1');
  if (bootstrapLease.repository !== targetRepository || bootstrapLease.issueNumber !== issueNumber) throw new Error('bootstrap lease target does not match requested delivery');
  if (bootstrapLease.baseBranch !== String(baseBranch ?? '')) throw new Error('bootstrap lease base branch does not match requested delivery');
  if (bootstrapLease.status !== 'reserved-initial-attempt') throw new Error('bootstrap recovery requires reserved-initial-attempt state');
  positiveInteger(bootstrapLease.implementationAttempts, 'bootstrapLease.implementationAttempts');
  if (!String(bootstrapLease.workerWorkflow ?? '').trim()) throw new Error('bootstrap recovery requires worker workflow identity');
  if (!String(bootstrapLease.dispatchNonce ?? '').trim()) throw new Error('bootstrap recovery requires dispatch nonce');
  assertAiPolicyMatch({ persistedProvider: bootstrapLease.provider, persistedModel: bootstrapLease.model, expectedProvider: provider, expectedModel: model, label: 'bootstrap lease' });
}

function bootstrapRecoveryDecision({ pullRequest, remoteHeadSha, bootstrapLease, recoveredWorkerRun, targetRepository, issueNumber, baseBranch, provider, model }) {
  if (!bootstrapLease || recoveredWorkerRun?.status !== 'completed' || recoveredWorkerRun?.conclusion !== 'success') return null;
  assertBootstrapRecoveryLease(bootstrapLease, { targetRepository, issueNumber, baseBranch, provider, model });
  const workerRunId = positiveInteger(recoveredWorkerRun.id, 'recoveredWorkerRun.id');
  return Object.freeze({
    runController: true,
    resumePr: null,
    recoverWorkerRunId: workerRunId,
    status: 'resume-initial-delivery',
    pullRequestNumber: positiveInteger(pullRequest.number, 'pullRequest.number'),
    materialHeadSha: remoteHeadSha,
    staleStateDetected: true,
    nextAction: 'recover-initial-attempt',
    priorInitialAttempts: bootstrapLease.implementationAttempts,
    dispatchNonce: bootstrapLease.dispatchNonce,
    attempts: { implementation: bootstrapLease.implementationAttempts }
  });
}

export function evaluateReentry({ pullRequest, stateEnvelope, bootstrapLease, targetRepository, issueNumber, baseBranch, provider, model = null, recoveredWorkerRun = null } = {}) {
  const resolvedIssue = positiveInteger(issueNumber, 'issueNumber');
  const resolvedProvider = String(provider ?? '').toLowerCase();

  if (pullRequest) {
    const prNumber = positiveInteger(pullRequest.number, 'pullRequest.number');
    const remoteHeadSha = String(pullRequest?.head?.sha ?? '').trim().toLowerCase();
    if (!SHA_RE.test(remoteHeadSha)) throw new Error('pullRequest.head.sha must be a 40-character Git commit SHA');

    if (!stateEnvelope) {
      const recovery = bootstrapRecoveryDecision({ pullRequest, remoteHeadSha, bootstrapLease, recoveredWorkerRun, targetRepository, issueNumber: resolvedIssue, baseBranch, provider: resolvedProvider, model });
      if (recovery) return recovery;
      return Object.freeze({
        runController: false,
        resumePr: null,
        status: 'escalated-missing-persistent-state',
        pullRequestNumber: prNumber,
        materialHeadSha: remoteHeadSha,
        staleStateDetected: true,
        nextAction: 'human-escalation',
        attempts: bootstrapLease ? { implementation: bootstrapLease.implementationAttempts } : null
      });
    }

    const persistent = stateEnvelope.persistent;
    if (persistent.issueNumber !== resolvedIssue) throw new Error('persisted state issue does not match requested issue');
    if (String(persistent.baseRef ?? '') !== String(baseBranch ?? '')) throw new Error('persisted state baseRef does not match requested base branch');
    assertAiPolicyMatch({ persistedProvider: persistent.provider, persistedModel: persistent.model ?? null, expectedProvider: resolvedProvider, expectedModel: model, label: 'persisted state' });

    const resumed = reconcilePersistentState(persistent, {
      repository: targetRepository,
      pullRequestNumber: prNumber,
      headRef: String(pullRequest?.head?.ref ?? ''),
      baseSha: String(pullRequest?.base?.sha ?? ''),
      remoteHeadSha
    });
    return Object.freeze({
      runController: true,
      resumePr: prNumber,
      status: stateEnvelope.controller?.adoption?.type === 'legacy-adopted' ? 'legacy-adopted' : 'resume-existing-delivery',
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
    if (bootstrapLease.baseBranch !== String(baseBranch ?? '')) throw new Error('bootstrap lease base branch does not match requested delivery');
    assertAiPolicyMatch({ persistedProvider: bootstrapLease.provider, persistedModel: bootstrapLease.model, expectedProvider: resolvedProvider, expectedModel: model, label: 'bootstrap lease' });
    const policy = executionPolicyFor(bootstrapLease.effectiveRisk || 'critical');
    if (recoveredWorkerRun && !['completed'].includes(String(recoveredWorkerRun.status ?? ''))) {
      return Object.freeze({ runController: true, resumePr: null, recoverWorkerRunId: Number(recoveredWorkerRun.id), status: 'resume-initial-delivery', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'recover-initial-attempt', priorInitialAttempts: bootstrapLease.implementationAttempts, dispatchNonce: bootstrapLease.dispatchNonce, attempts: { implementation: bootstrapLease.implementationAttempts } });
    }
    if (recoveredWorkerRun?.status === 'completed' && recoveredWorkerRun?.conclusion === 'success') {
      return Object.freeze({ runController: true, resumePr: null, recoverWorkerRunId: Number(recoveredWorkerRun.id), status: 'resume-initial-delivery', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'recover-initial-attempt', priorInitialAttempts: bootstrapLease.implementationAttempts, dispatchNonce: bootstrapLease.dispatchNonce, attempts: { implementation: bootstrapLease.implementationAttempts } });
    }
    if (bootstrapLease.implementationAttempts >= policy.maxImplementationAttempts) {
      return Object.freeze({ runController: false, resumePr: null, recoverWorkerRunId: null, status: 'escalated-initial-budget-exhausted', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'human-escalation', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
    }
    return Object.freeze({ runController: true, resumePr: null, recoverWorkerRunId: null, status: 'retry-initial-delivery', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'retry-initial-worker', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
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

function assertRecoveredWorkerIdentity(run, lease, orchestratorRef) {
  const correlated = selectCorrelatedWorkflowRun([run], { kind: 'worker', nonce: lease.dispatchNonce, ref: orchestratorRef });
  if (!correlated) throw new Error(`worker run is not correlated with ${expectedDispatchTitle('worker', lease.dispatchNonce)}`);
  const expectedWorkflow = String(lease.workerWorkflow ?? '').trim();
  const runPath = String(run?.path ?? '').split('@', 1)[0];
  if (expectedWorkflow && runPath && !runPath.endsWith(`/${expectedWorkflow}`)) throw new Error('worker run workflow does not match bootstrap lease');
  return correlated;
}

async function recoverBootstrapWorkerRun(lease, orchestratorRepository, orchestratorRef, token) {
  if (!lease) return null;
  if (lease.workerRunId) {
    const run = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${lease.workerRunId}`, token);
    return assertRecoveredWorkerIdentity(run, lease, orchestratorRef);
  }
  if (!lease.workerWorkflow || !lease.dispatchNonce) return null;
  const payload = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/workflows/${encodeURIComponent(lease.workerWorkflow)}/runs?event=workflow_dispatch&per_page=100`, token);
  const run = selectCorrelatedWorkflowRun(payload.workflow_runs ?? [], { kind: 'worker', nonce: lease.dispatchNonce, ref: orchestratorRef });
  return run ? assertRecoveredWorkerIdentity(run, lease, orchestratorRef) : null;
}

async function writeGithubOutput(decision) {
  const outputPath = String(process.env.GITHUB_OUTPUT ?? '').trim();
  if (!outputPath) return;
  const lines = [
    `run_controller=${decision.runController ? 'true' : 'false'}`,
    `resume_pr=${decision.resumePr ?? ''}`,
    `status=${decision.status}`,
    `pr_number=${decision.pullRequestNumber ?? ''}`,
    `next_action=${decision.nextAction}`,
    `prior_initial_attempts=${decision.priorInitialAttempts ?? 0}`,
    `recover_worker_run_id=${decision.recoverWorkerRunId ?? ''}`,
    `dispatch_nonce=${decision.dispatchNonce ?? ''}`
  ].join('\n');
  await appendFile(outputPath, `${lines}\n`, 'utf8');
}

async function main() {
  const targetRepository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  requiredEnv('DELIVERY_AI_PROVIDER');
  const readToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const writeToken = requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN');
  const actionsToken = requiredEnv('GITHUB_TOKEN');
  const orchestratorRepository = requiredEnv('GITHUB_REPOSITORY');
  const orchestratorRef = requiredEnv('ORCHESTRATOR_WORKER_REF');
  const resultPath = String(process.env.CONTROLLER_RESULT_PATH ?? '').trim();

  const trustedLogin = trustedCommentAuthorForRepository(targetRepository);
  const pulls = await listOpenPullRequests(targetRepository, baseBranch, readToken);
  const pullRequest = selectManagedPullRequest(pulls, { issueNumber, baseBranch, trustedLogin, repository: targetRepository });
  let stateEnvelope = null;
  let bootstrapLease = null;
  if (pullRequest) {
    stateEnvelope = parsePersistentStateEnvelope(await listIssueComments(targetRepository, pullRequest.number, readToken), { trustedLogin });
    if (!stateEnvelope && !String(pullRequest.title ?? '').startsWith('[delivery-v2] ')) {
      const effectiveRisk = 'critical';
      const aiPolicy = loadV2Config({}, process.env).aiPolicy;
      const expected = resolveProviderSelectionForRisk(aiPolicy, effectiveRisk).implementer;
      stateEnvelope = createLegacyAdoptionEnvelope({ pullRequest, repository: targetRepository, issueNumber, provider: expected.provider, model: expected.model, effectiveRisk, controllerRunId: requiredEnv('GITHUB_RUN_ID') });
      const body = `${STATE_MARKER}\n## Delivery V2 controller state\n\n\`\`\`json\n${JSON.stringify(stateEnvelope, null, 2)}\n\`\`\``;
      await api(`https://api.github.com/repos/${targetRepository}/issues/${pullRequest.number}/comments`, writeToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
    }
  }
  if (!stateEnvelope) bootstrapLease = parseBootstrapLease(await listIssueComments(targetRepository, issueNumber, readToken), { trustedLogin });

  const provenance = stateEnvelope?.controller ?? bootstrapLease;
  if (provenance) {
    const controllerRunId = positiveInteger(provenance.controllerRunId, 'controllerRunId');
    const controllerRun = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${controllerRunId}`, actionsToken);
    validateControllerRunProvenance(controllerRun, { orchestratorRepository, trustedRef: orchestratorRef });
  }
  const recoveredWorkerRun = bootstrapLease ? await recoverBootstrapWorkerRun(bootstrapLease, orchestratorRepository, orchestratorRef, actionsToken) : null;
  const effectiveRisk = stateEnvelope?.persistent?.effectiveRisk ?? bootstrapLease?.effectiveRisk ?? 'critical';
  const aiPolicy = loadV2Config({}, process.env).aiPolicy;
  const expectedImplementer = resolveProviderSelectionForRisk(aiPolicy, effectiveRisk).implementer;
  const decision = evaluateReentry({
    pullRequest,
    stateEnvelope,
    bootstrapLease,
    targetRepository,
    issueNumber,
    baseBranch,
    provider: expectedImplementer.provider,
    model: expectedImplementer.model,
    recoveredWorkerRun
  });
  if (decision.status === 'escalated-initial-budget-exhausted' && bootstrapLease?.commentId) {
    const terminalLease = terminalizeBootstrapLease(bootstrapLease, decision.status);
    const body = `${BOOTSTRAP_MARKER}\n## Delivery V2 bootstrap state\n\n\`\`\`json\n${JSON.stringify(terminalLease, null, 2)}\n\`\`\``;
    await api(`https://api.github.com/repos/${targetRepository}/issues/comments/${bootstrapLease.commentId}`, writeToken, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  }
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
