#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadV2Config } from '../src/v2/config.mjs';
import { reconcilePersistentState } from '../src/v2/persistent-state.mjs';
import { executionPolicyFor } from '../src/v2/execution-policy.mjs';
import { resolveProviderSelectionForRisk } from '../src/v2/provider-policy.mjs';
import { createDispatchNonce, expectedDispatchTitle, selectCorrelatedWorkflowRun } from '../src/v2/controller-runtime.mjs';
import { parseTrustedJsonEnvelope, selectExistingPullRequest, trustedCommentAuthorForRepository, validateControllerRunProvenance } from '../src/v2/controller-provenance.mjs';
import { classifyLegacyAdoptionBootstrap, createLegacyAdoption, legacyAdoptionComment, parseLegacyAdoptionEnvelope, reconcileLegacyAdoption, validateLegacyAdoptionControllerRun } from '../src/v2/legacy-adoption.mjs';
import { withTransientFetchRetry } from '../src/v2/github-api-retry.mjs';
import { recordControllerTechnicalError } from '../src/v2/controller-summary.mjs';
import { assertChangedPathsAuthorized, createWorkerScopeBinding, issueContractFingerprint } from '../.github/scripts/delivery-v2-worker-scope-contract.mjs';
import { downloadGhAwAgentOutputArtifact } from '../src/v2/gh-aw-agent-output-artifact.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const BOOTSTRAP_MARKER = '<!-- delivery-v2-bootstrap-state -->';
const SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const RECOVERABLE_PRE_MATERIAL_FAILURE_CLASSES = new Set(['infrastructure', 'unknown']);
const RECOVERABLE_PRE_MATERIAL_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);

function normalizedSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

function normalizedFingerprint(value) {
  const fingerprint = String(value ?? '').trim().toLowerCase();
  return SHA256_RE.test(fingerprint) ? fingerprint : null;
}

export function resolveCheckedOutControlPlaneHeadSha({
  readHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
} = {}) {
  const sha = normalizedSha(readHead());
  if (!sha) {
    throw new Error('checked-out control-plane HEAD must be an exact Git commit SHA');
  }
  return sha;
}

export function recoveryContextForExhaustedBootstrap({
  bootstrapLease,
  currentControllerHeadSha,
  bootstrapControllerHeadSha = null
} = {}) {
  const previousControllerHeadSha = normalizedSha(
    bootstrapLease?.recovery?.currentControllerHeadSha
      ?? bootstrapLease?.controllerHeadSha
      ?? bootstrapControllerHeadSha
  );
  const currentControlPlaneHeadSha = normalizedSha(
    currentControllerHeadSha
  );
  const previousImplementationAttempts = Number(
    bootstrapLease?.implementationAttempts
  );
  const failureClass = String(
    bootstrapLease?.failureClass ?? ''
  ).trim().toLowerCase();
  const workerConclusion = String(
    bootstrapLease?.workerConclusion ?? ''
  ).trim().toLowerCase();

  const eligible =
    bootstrapLease?.status === 'escalated-initial-budget-exhausted'
    && bootstrapLease?.failureStage === 'pre-material'
    && RECOVERABLE_PRE_MATERIAL_FAILURE_CLASSES.has(failureClass)
    && RECOVERABLE_PRE_MATERIAL_CONCLUSIONS.has(workerConclusion)
    && Number.isInteger(previousImplementationAttempts)
    && previousImplementationAttempts >= 1
    && previousControllerHeadSha
    && currentControlPlaneHeadSha
    && previousControllerHeadSha !== currentControlPlaneHeadSha;

  if (!eligible) return null;

  return Object.freeze({
    reason: 'control-plane-changed-after-pre-material-exhaustion',
    previousImplementationAttempts,
    previousControllerHeadSha,
    currentControllerHeadSha: currentControlPlaneHeadSha,
    grantedImplementationAttempts: 1
  });
}


export function recoveryContextForLegacyNonrecoverableBootstrap({
  bootstrapLease,
  currentControllerHeadSha,
  bootstrapControllerHeadSha = null,
  authorizationFailure = null
} = {}) {
  const previousControllerHeadSha = normalizedSha(
    bootstrapLease?.recovery?.currentControllerHeadSha
      ?? bootstrapLease?.controllerHeadSha
      ?? bootstrapControllerHeadSha
  );
  const currentControlPlaneHeadSha = normalizedSha(currentControllerHeadSha);
  const previousImplementationAttempts = Number(bootstrapLease?.implementationAttempts);
  const lastFailure = bootstrapLease?.lastFailure;

  const eligible =
    bootstrapLease?.status === 'escalated-initial-nonrecoverable'
    && lastFailure?.failureStage === 'pre-material'
    && lastFailure?.hasPatch === false
    && Number.isInteger(previousImplementationAttempts)
    && previousImplementationAttempts >= 1
    && previousControllerHeadSha
    && currentControlPlaneHeadSha
    && previousControllerHeadSha !== currentControlPlaneHeadSha
    && authorizationFailure?.classification === 'bootstrap-controller-run-mismatch'
    && Number(authorizationFailure.workerRunId) === Number(lastFailure.workerRunId);

  if (!eligible) return null;

  return Object.freeze({
    reason: 'control-plane-changed-after-legacy-authorization-failure',
    previousImplementationAttempts,
    previousControllerHeadSha,
    currentControllerHeadSha: currentControlPlaneHeadSha,
    grantedImplementationAttempts: 0,
    retryMode: 'reuse-current-attempt',
    previousWorkerRunId: Number(lastFailure.workerRunId),
    persistedClassification: String(lastFailure.classification ?? '')
  });
}

export function recoveryContextForScopeCorrection({
  bootstrapLease,
  scopeGuardFailure = null,
  observedPatch = null,
  correctedScopeBinding = null
} = {}) {
  if (
    bootstrapLease?.status !== 'escalated-initial-nonrecoverable'
    || scopeGuardFailure?.classification !== 'material-scope-guard-rejected-local-patch'
    || Number(scopeGuardFailure.workerRunId) !== Number(bootstrapLease?.lastFailure?.workerRunId)
    || observedPatch?.hasPatch !== true
    || observedPatch?.materialPublished !== false
    || !Array.isArray(observedPatch.changedPaths)
    || observedPatch.changedPaths.length === 0
    || bootstrapLease?.lastFailure?.hasPatch !== true
  ) return null;

  try {
    assertChangedPathsAuthorized(observedPatch.changedPaths, bootstrapLease.scopeBinding);
    return null;
  } catch {
    // The persisted envelope must reject the exact local patch; otherwise this
    // is not a scope-correction re-entry.
  }

  try {
    const accepted = assertChangedPathsAuthorized(observedPatch.changedPaths, correctedScopeBinding);
    if (String(correctedScopeBinding?.enforcement ?? '') !== 'explicit-exclusive') return null;
    return Object.freeze({
      reason: 'material-scope-corrected-after-local-patch-rejection',
      previousImplementationAttempts: Number(bootstrapLease.implementationAttempts),
      grantedImplementationAttempts: 0,
      retryMode: 'reuse-current-attempt',
      previousWorkerRunId: Number(bootstrapLease.lastFailure.workerRunId),
      changedPaths: accepted.changedPaths,
      previousScopeBinding: bootstrapLease.scopeBinding,
      correctedScopeBinding,
      evidenceRef: scopeGuardFailure.evidenceRef ?? observedPatch.evidenceRef ?? null
    });
  } catch {
    return null;
  }
}

export function recoveryContextForSuccessfulBootstrapWithoutPr({
  bootstrapLease,
  currentControllerHeadSha,
  bootstrapControllerHeadSha = null,
  currentIssueContractSha256 = null
} = {}) {
  const previousControllerHeadSha = normalizedSha(
    bootstrapLease?.recovery?.currentControllerHeadSha
      ?? bootstrapLease?.controllerHeadSha
      ?? bootstrapControllerHeadSha
  );
  const currentControlPlaneHeadSha = normalizedSha(
    currentControllerHeadSha
  );
  const previousImplementationAttempts = Number(
    bootstrapLease?.implementationAttempts
  );
  const previousIssueContractSha256 = normalizedFingerprint(
    bootstrapLease?.scopeBinding?.issueContractSha256
  );
  const currentIssueFingerprint = normalizedFingerprint(
    currentIssueContractSha256
  );
  const controllerChanged = Boolean(
    previousControllerHeadSha
      && currentControlPlaneHeadSha
      && previousControllerHeadSha !== currentControlPlaneHeadSha
  );
  const issueContractChanged = Boolean(
    previousIssueContractSha256
      && currentIssueFingerprint
      && previousIssueContractSha256 !== currentIssueFingerprint
  );

  const eligible =
    bootstrapLease?.status === 'reserved-initial-attempt'
    && Number.isInteger(previousImplementationAttempts)
    && previousImplementationAttempts >= 1
    && previousControllerHeadSha
    && currentControlPlaneHeadSha
    && (controllerChanged || issueContractChanged);

  if (!eligible) return null;

  return Object.freeze({
    reason: issueContractChanged
      ? 'issue-contract-changed-after-successful-pre-material-worker-without-pr'
      : 'control-plane-changed-after-successful-pre-material-worker-without-pr',
    previousImplementationAttempts,
    previousControllerHeadSha,
    currentControllerHeadSha: currentControlPlaneHeadSha,
    grantedImplementationAttempts: 1,
    ...(issueContractChanged
      ? {
          previousIssueContractSha256,
          currentIssueContractSha256: currentIssueFingerprint
        }
      : {})
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

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-reentry-guard'
  };
}

async function api(url, token, options = {}) {
  const response = await withTransientFetchRetry(
    () => fetch(url, { ...options, headers: { ...headers(token), ...(options.headers ?? {}) } }),
    { label: `reentry guard ${options.method ?? 'GET'} ${url}` }
  );
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${options.method ?? 'GET'} ${url}: ${await response.text()}`);
  return response.json();
}

function githubLogPayload(line) {
  const value = String(line ?? '');
  const timestamped = value.match(
    /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+(.*)$/
  );
  return String(timestamped?.[1] ?? value).trim();
}

export function checkedOutControlPlaneHeadShaFromJobLog(logText) {
  const lines = String(logText ?? '').split(/\r?\n/);
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = githubLogPayload(lines[index]);

    if (
      !current.includes(
        '[command]/usr/bin/git log -1 --format=%H'
      )
    ) {
      continue;
    }

    for (
      let candidateIndex = index + 1;
      candidateIndex < Math.min(lines.length, index + 8);
      candidateIndex += 1
    ) {
      const payload = githubLogPayload(lines[candidateIndex]);
      const sha = normalizedSha(payload);

      if (sha) {
        candidates.push(sha);
        break;
      }
    }
  }

  const unique = [...new Set(candidates)];

  if (unique.length !== 1) {
    throw new Error(
      'legacy controller checkout provenance requires exactly one '
      + 'checked-out control-plane SHA'
    );
  }

  return unique[0];
}

export async function resolveBootstrapControllerHeadShaFromRun({
  bootstrapLease,
  controllerRun,
  orchestratorRepository,
  trustedRef,
  actionsToken,
  listJobs = async ({ repository, runId, token }) => {
    const payload = await api(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
      token
    );
    return payload.jobs ?? [];
  },
  readJobLog = async ({ repository, jobId, token }) => {
    const url =
      `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`;

    const response = await withTransientFetchRetry(
      () => fetch(url, { headers: headers(token) }),
      { label: `legacy controller checkout log ${jobId}` }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} GET ${url}: ${await response.text()}`
      );
    }

    return response.text();
  }
} = {}) {
  const persisted = normalizedSha(
    bootstrapLease?.recovery?.currentControllerHeadSha
      ?? bootstrapLease?.controllerHeadSha
  );

  if (persisted) return persisted;

  if (
    bootstrapLease?.status
      !== 'escalated-initial-budget-exhausted'
  ) {
    return null;
  }

  const runId = positiveInteger(
    bootstrapLease?.controllerRunId,
    'bootstrap controllerRunId'
  );

  const observedRunId = positiveInteger(
    controllerRun?.id,
    'controller workflow run id'
  );

  if (observedRunId !== runId) {
    throw new Error(
      'bootstrap controller run does not match persisted provenance'
    );
  }

  validateControllerRunProvenance(controllerRun, {
    orchestratorRepository,
    trustedRef
  });

  const jobs = await listJobs({
    repository: orchestratorRepository,
    runId,
    token: actionsToken
  });

  if (!Array.isArray(jobs)) {
    throw new Error('controller workflow jobs must be an array');
  }

  const matchingJobs = jobs.filter(
    (job) => String(job?.name ?? '')
      === 'Bounded deterministic delivery'
  );

  if (matchingJobs.length !== 1) {
    throw new Error(
      'legacy controller checkout provenance requires exactly one '
      + 'Bounded deterministic delivery job'
    );
  }

  const jobId = positiveInteger(
    matchingJobs[0].id,
    'controller workflow job id'
  );

  const logText = await readJobLog({
    repository: orchestratorRepository,
    jobId,
    token: actionsToken
  });

  return checkedOutControlPlaneHeadShaFromJobLog(logText);
}

// Preserve the public entrypoint while sharing the exact identity contract with resume.
export const selectManagedPullRequest = selectExistingPullRequest;

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
    ...value,
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
  if (bootstrapLease.status === 'escalated-initial-budget-exhausted') return null;
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

export function evaluateReentry({ pullRequest, stateEnvelope, adoptionEnvelope = null, bootstrapLease, targetRepository, issueNumber, baseBranch, provider, model = null, recoveredWorkerRun = null, bootstrapControllerHeadSha = null, currentControllerHeadSha = null, currentIssueContractSha256 = null, legacyAuthorizationFailure = null, scopeGuardFailure = null, observedPatch = null, correctedScopeBinding = null, rearmDispatchNonce = null } = {}) {
  const resolvedIssue = positiveInteger(issueNumber, 'issueNumber');
  const resolvedProvider = String(provider ?? '').toLowerCase();

  if (pullRequest) {
    if (!selectExistingPullRequest([pullRequest], { repository: targetRepository, issueNumber: resolvedIssue, baseBranch, trustedLogin: trustedCommentAuthorForRepository(targetRepository) })) {
      throw new Error('existing PR is not bound to requested issue');
    }
    const prNumber = positiveInteger(pullRequest.number, 'pullRequest.number');
    const remoteHeadSha = String(pullRequest?.head?.sha ?? '').trim().toLowerCase();
    if (!SHA_RE.test(remoteHeadSha)) throw new Error('pullRequest.head.sha must be a 40-character Git commit SHA');

    if (!stateEnvelope) {
      // A correlated V2 publication keeps its existing recovery path. A legacy PR
      // is not retroactively claimed as output of that bootstrap worker.
      const recovery = !adoptionEnvelope && String(pullRequest.title ?? '').startsWith('[delivery-v2] ')
        ? bootstrapRecoveryDecision({ pullRequest, remoteHeadSha, bootstrapLease, recoveredWorkerRun, targetRepository, issueNumber: resolvedIssue, baseBranch, provider: resolvedProvider, model }) : null;
      if (recovery) return recovery;
      if (adoptionEnvelope && (adoptionEnvelope.adoption.repository !== targetRepository || adoptionEnvelope.adoption.issueNumber !== resolvedIssue || adoptionEnvelope.adoption.baseRef !== baseBranch)) throw new Error('adoption target does not match requested delivery');
      const adoption = adoptionEnvelope
        ? reconcileLegacyAdoption(adoptionEnvelope.adoption, pullRequest)
        : createLegacyAdoption({ pullRequest, repository: targetRepository, issueNumber: resolvedIssue, baseBranch, bootstrapLease });
      return Object.freeze({
        runController: true,
        resumePr: prNumber,
        status: 'legacy-adopted',
        pullRequestNumber: prNumber,
        materialHeadSha: remoteHeadSha,
        headRef: pullRequest.head.ref,
        staleStateDetected: adoption.phase === 'blocked',
        nextAction: 'post-write-refreeze',
        attempts: adoption.attempts,
        adoption
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
    if (bootstrapLease.baseBranch !== String(baseBranch ?? '')) throw new Error('bootstrap lease base branch does not match requested delivery');
    assertAiPolicyMatch({ persistedProvider: bootstrapLease.provider, persistedModel: bootstrapLease.model, expectedProvider: resolvedProvider, expectedModel: model, label: 'bootstrap lease' });
    const policy = executionPolicyFor(bootstrapLease.effectiveRisk || 'critical');

    // A persisted terminal exhaustion is terminal regardless of a later
    // runtime increase to MAX_IMPLEMENTATION_ATTEMPTS. Its only automatic
    // recovery path is an eligible pre-material failure plus a verified
    // checked-out control-plane SHA change.
    if (bootstrapLease.status === 'escalated-initial-budget-exhausted') {
      const recovery = recoveryContextForExhaustedBootstrap({
        bootstrapLease,
        currentControllerHeadSha,
        bootstrapControllerHeadSha
      });

      if (recovery) {
        return Object.freeze({
          runController: true,
          resumePr: null,
          recoverWorkerRunId: null,
          status: 'retry-initial-delivery',
          pullRequestNumber: null,
          materialHeadSha: null,
          staleStateDetected: false,
          nextAction: 'retry-initial-worker',
          priorInitialAttempts: Math.max(
            0,
            recovery.previousImplementationAttempts - 1
          ),
          attempts: {
            implementation: recovery.previousImplementationAttempts
          },
          recovery
        });
      }

      return Object.freeze({
        runController: false,
        resumePr: null,
        recoverWorkerRunId: null,
        status: 'escalated-initial-budget-exhausted',
        pullRequestNumber: null,
        materialHeadSha: null,
        staleStateDetected: false,
        nextAction: 'human-escalation',
        priorInitialAttempts: bootstrapLease.implementationAttempts,
        attempts: {
          implementation: bootstrapLease.implementationAttempts
        }
      });
    }
    if (bootstrapLease.status === 'escalated-initial-nonrecoverable') {
      const recovery = recoveryContextForScopeCorrection({
        bootstrapLease,
        scopeGuardFailure,
        observedPatch,
        correctedScopeBinding
      }) ?? recoveryContextForLegacyNonrecoverableBootstrap({
        bootstrapLease,
        currentControllerHeadSha,
        bootstrapControllerHeadSha,
        authorizationFailure: legacyAuthorizationFailure
      });

      if (recovery) {
        const dispatchNonce = String(rearmDispatchNonce ?? '').trim();
        if (!dispatchNonce) {
          throw new Error('legacy nonrecoverable bootstrap recovery requires a fresh dispatch nonce');
        }
        return Object.freeze({
          runController: true,
          resumePr: null,
          recoverWorkerRunId: null,
          reuseReservedAttempt: true,
          status: 'retry-initial-delivery',
          pullRequestNumber: null,
          materialHeadSha: null,
          staleStateDetected: false,
          nextAction: 'dispatch-reserved-initial-attempt',
          priorInitialAttempts: bootstrapLease.implementationAttempts,
          dispatchNonce,
          attempts: { implementation: bootstrapLease.implementationAttempts },
          recovery
        });
      }

      return Object.freeze({
        runController: false,
        resumePr: null,
        recoverWorkerRunId: null,
        status: 'escalated-initial-nonrecoverable',
        pullRequestNumber: null,
        materialHeadSha: null,
        staleStateDetected: false,
        nextAction: 'human-escalation',
        priorInitialAttempts: bootstrapLease.implementationAttempts,
        attempts: { implementation: bootstrapLease.implementationAttempts }
      });
    }

    if (recoveredWorkerRun && !['completed'].includes(String(recoveredWorkerRun.status ?? ''))) {
      return Object.freeze({ runController: true, resumePr: null, recoverWorkerRunId: Number(recoveredWorkerRun.id), status: 'resume-initial-delivery', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'recover-initial-attempt', priorInitialAttempts: bootstrapLease.implementationAttempts, dispatchNonce: bootstrapLease.dispatchNonce, attempts: { implementation: bootstrapLease.implementationAttempts } });
    }

    if (recoveredWorkerRun?.status === 'completed' && recoveredWorkerRun?.conclusion === 'success') {
      const recovery = recoveryContextForSuccessfulBootstrapWithoutPr({
        bootstrapLease,
        currentControllerHeadSha,
        bootstrapControllerHeadSha,
        currentIssueContractSha256
      });

      if (recovery?.reason === 'issue-contract-changed-after-successful-pre-material-worker-without-pr') {
        const dispatchNonce = String(rearmDispatchNonce ?? '').trim();
        if (!dispatchNonce) {
          throw new Error('issue-contract bootstrap recovery requires a fresh dispatch nonce');
        }
        return Object.freeze({
          runController: true,
          resumePr: null,
          recoverWorkerRunId: null,
          reuseReservedAttempt: true,
          status: 'retry-initial-delivery',
          pullRequestNumber: null,
          materialHeadSha: null,
          staleStateDetected: true,
          nextAction: 'dispatch-reserved-initial-attempt',
          priorInitialAttempts: bootstrapLease.implementationAttempts,
          dispatchNonce,
          attempts: {
            implementation: recovery.previousImplementationAttempts
          },
          recovery
        });
      }

      if (recovery) {
        return Object.freeze({
          runController: true,
          resumePr: null,
          recoverWorkerRunId: null,
          status: 'retry-initial-delivery',
          pullRequestNumber: null,
          materialHeadSha: null,
          staleStateDetected: false,
          nextAction: 'retry-initial-worker',
          priorInitialAttempts: Math.max(
            0,
            recovery.previousImplementationAttempts - 1
          ),
          attempts: {
            implementation: recovery.previousImplementationAttempts
          },
          recovery
        });
      }

      return Object.freeze({
        runController: true,
        resumePr: null,
        recoverWorkerRunId: Number(recoveredWorkerRun.id),
        status: 'resume-initial-delivery',
        pullRequestNumber: null,
        materialHeadSha: null,
        staleStateDetected: false,
        nextAction: 'recover-initial-attempt',
        priorInitialAttempts: bootstrapLease.implementationAttempts,
        dispatchNonce: bootstrapLease.dispatchNonce,
        attempts: {
          implementation: bootstrapLease.implementationAttempts
        }
      });
    }

    const observedFailure = (
      bootstrapLease.lastFailure
      && Number(bootstrapLease.lastFailure.attempt) === Number(bootstrapLease.implementationAttempts)
    ) ? bootstrapLease.lastFailure : null;
    const observedFailureMatchesWorker = observedFailure && recoveredWorkerRun
      ? Number(observedFailure.workerRunId) === Number(recoveredWorkerRun.id)
      : Boolean(observedFailure);

    if (recoveredWorkerRun?.status === 'completed' && recoveredWorkerRun?.conclusion !== 'success') {
      if (!observedFailureMatchesWorker) {
        if (bootstrapLease.implementationAttempts >= policy.maxImplementationAttempts) {
          return Object.freeze({ runController: false, resumePr: null, recoverWorkerRunId: null, status: 'escalated-initial-budget-exhausted', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'human-escalation', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
        }
        return Object.freeze({
          runController: true,
          resumePr: null,
          recoverWorkerRunId: Number(recoveredWorkerRun.id),
          status: 'resume-initial-delivery',
          pullRequestNumber: null,
          materialHeadSha: null,
          staleStateDetected: false,
          nextAction: 'recover-initial-attempt',
          priorInitialAttempts: bootstrapLease.implementationAttempts,
          dispatchNonce: bootstrapLease.dispatchNonce,
          attempts: { implementation: bootstrapLease.implementationAttempts }
        });
      }
      if (observedFailure.recoverable !== true) {
        return Object.freeze({ runController: false, resumePr: null, recoverWorkerRunId: null, status: 'escalated-initial-nonrecoverable', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'human-escalation', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
      }
      if (bootstrapLease.implementationAttempts >= policy.maxImplementationAttempts) {
        return Object.freeze({ runController: false, resumePr: null, recoverWorkerRunId: null, status: 'escalated-initial-budget-exhausted', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'human-escalation', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
      }
      return Object.freeze({ runController: true, resumePr: null, recoverWorkerRunId: null, status: 'retry-initial-delivery', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'retry-initial-worker', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
    }

    if (!recoveredWorkerRun && observedFailure) {
      if (observedFailure.recoverable !== true) {
        return Object.freeze({ runController: false, resumePr: null, recoverWorkerRunId: null, status: 'escalated-initial-nonrecoverable', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'human-escalation', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
      }
      if (bootstrapLease.implementationAttempts >= policy.maxImplementationAttempts) {
        return Object.freeze({ runController: false, resumePr: null, recoverWorkerRunId: null, status: 'escalated-initial-budget-exhausted', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'human-escalation', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
      }
      return Object.freeze({ runController: true, resumePr: null, recoverWorkerRunId: null, status: 'retry-initial-delivery', pullRequestNumber: null, materialHeadSha: null, staleStateDetected: false, nextAction: 'retry-initial-worker', priorInitialAttempts: bootstrapLease.implementationAttempts, attempts: { implementation: bootstrapLease.implementationAttempts } });
    }

    if (String(bootstrapLease.dispatchNonce ?? '').trim()) {
      return Object.freeze({
        runController: true,
        resumePr: null,
        recoverWorkerRunId: null,
        reuseReservedAttempt: true,
        status: 'resume-initial-delivery',
        pullRequestNumber: null,
        materialHeadSha: null,
        staleStateDetected: false,
        nextAction: 'dispatch-reserved-initial-attempt',
        priorInitialAttempts: bootstrapLease.implementationAttempts,
        dispatchNonce: bootstrapLease.dispatchNonce,
        attempts: { implementation: bootstrapLease.implementationAttempts }
      });
    }

    // Legacy reservations created before dispatch nonces cannot prove that an
    // undispatched slot is safely reusable. Preserve their historical bounded
    // retry/exhaustion behavior instead of fabricating a reusable reservation.
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

async function listOpenPullRequests(repository, token) {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`https://api.github.com/repos/${repository}/pulls?state=open&per_page=100&page=${page}`, token);
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

export async function recoverBootstrapWorkerRun(lease, orchestratorRepository, orchestratorRef, token) {
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

export async function detectLegacyBootstrapControllerRunMismatch({
  bootstrapLease,
  recoveredWorkerRun,
  orchestratorRepository,
  actionsToken,
  listJobs = async ({ repository, runId, token }) => {
    const payload = await api(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
      token
    );
    return payload.jobs ?? [];
  },
  readJobLog = async ({ repository, jobId, token }) => {
    const url = `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`;
    const response = await withTransientFetchRetry(
      () => fetch(url, { headers: headers(token) }),
      { label: `legacy bootstrap authorization log ${jobId}` }
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
    return response.text();
  }
} = {}) {
  if (
    bootstrapLease?.status !== 'escalated-initial-nonrecoverable'
    || bootstrapLease?.lastFailure?.failureStage !== 'pre-material'
    || bootstrapLease?.lastFailure?.hasPatch !== false
    || recoveredWorkerRun?.status !== 'completed'
    || recoveredWorkerRun?.conclusion !== 'failure'
    || Number(recoveredWorkerRun.id) !== Number(bootstrapLease?.lastFailure?.workerRunId)
  ) {
    return null;
  }

  const jobs = await listJobs({
    repository: orchestratorRepository,
    runId: recoveredWorkerRun.id,
    token: actionsToken
  });

  const expectedAgentExecutionStep = ({
    codex: 'Execute Codex CLI',
    claude: 'Execute Claude Code CLI',
    copilot: 'Execute GitHub Copilot CLI'
  })[String(bootstrapLease?.provider ?? '').trim().toLowerCase()];
  if (!expectedAgentExecutionStep) return null;

  for (const job of jobs) {
    const authStep = (job.steps ?? []).find(
      (step) =>
        String(step?.name ?? '') === 'Validate controller-selected worker authorization'
        && String(step?.conclusion ?? '') === 'failure'
    );
    if (!authStep) continue;

    const agentExecutionSteps = (job.steps ?? []).filter(
      (step) => String(step?.name ?? '') === expectedAgentExecutionStep
    );
    if (agentExecutionSteps.length !== 1) continue;
    if (String(agentExecutionSteps[0].conclusion ?? '') !== 'skipped') continue;

    const log = await readJobLog({
      repository: orchestratorRepository,
      jobId: job.id,
      token: actionsToken
    });
    if (!log.includes('bootstrap controller run mismatch')) continue;

    return Object.freeze({
      classification: 'bootstrap-controller-run-mismatch',
      workerRunId: Number(recoveredWorkerRun.id),
      evidenceRef: job.html_url ?? recoveredWorkerRun.html_url ?? null
    });
  }

  return null;
}

export function rearmLegacyNonrecoverableBootstrapLease(
  lease,
  decision,
  { currentControllerRunId, currentControllerHeadSha } = {}
) {
  if (![
    'control-plane-changed-after-legacy-authorization-failure',
    'material-scope-corrected-after-local-patch-rejection'
  ].includes(decision?.recovery?.reason)) return null;
  if (lease?.status !== 'escalated-initial-nonrecoverable') {
    throw new Error('legacy nonrecoverable recovery requires escalated-initial-nonrecoverable state');
  }

  const activeControllerRunId = positiveInteger(currentControllerRunId, 'currentControllerRunId');
  const currentHeadSha = normalizedSha(currentControllerHeadSha);
  if (!currentHeadSha) throw new Error('currentControllerHeadSha must be an exact Git commit SHA');
  const dispatchNonce = String(decision.dispatchNonce ?? '').trim();
  if (!dispatchNonce) throw new Error('legacy nonrecoverable recovery requires dispatch nonce');

  const { commentId, lastFailure, ...value } = lease;
  const previousControllerRunId = positiveInteger(value.controllerRunId, 'bootstrap controllerRunId');
  const controllerRunHistory = [...new Set([
    ...(Array.isArray(value.controllerRunHistory) ? value.controllerRunHistory : []),
    previousControllerRunId
  ].map(Number).filter((item) => Number.isInteger(item) && item > 0 && item !== activeControllerRunId))];

  const previousHeadSha = normalizedSha(value.controllerHeadSha);
  const controllerProvenanceHistory = [
    ...(Array.isArray(value.controllerProvenanceHistory) ? value.controllerProvenanceHistory : []),
    ...(previousControllerRunId !== activeControllerRunId
      ? [{ controllerRunId: previousControllerRunId, controllerHeadSha: previousHeadSha }]
      : [])
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          Number(candidate?.controllerRunId) === Number(entry?.controllerRunId)
          && String(candidate?.controllerHeadSha ?? '') === String(entry?.controllerHeadSha ?? '')
      ) === index
  );

  return Object.freeze({
    ...value,
    status: 'reserved-initial-attempt',
    controllerRunId: activeControllerRunId,
    controllerRunHistory,
    controllerProvenanceHistory,
    controllerHeadSha: currentHeadSha,
    workerRunId: null,
    dispatchNonce,
    ...(decision.recovery.correctedScopeBinding
      ? { scopeBinding: Object.freeze({ ...decision.recovery.correctedScopeBinding }) }
      : {}),
    recovery: Object.freeze({
      ...decision.recovery,
      previousFailure: lastFailure ?? null
    })
  });
}

export async function detectMaterialScopeGuardFailure({
  bootstrapLease,
  recoveredWorkerRun,
  orchestratorRepository,
  actionsToken,
  listJobs = async ({ repository, runId, token }) => {
    const payload = await api(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, token);
    return payload.jobs ?? [];
  }
} = {}) {
  if (
    bootstrapLease?.status !== 'escalated-initial-nonrecoverable'
    || bootstrapLease?.lastFailure?.hasPatch !== true
    || recoveredWorkerRun?.status !== 'completed'
    || recoveredWorkerRun?.conclusion !== 'failure'
    || Number(recoveredWorkerRun.id) !== Number(bootstrapLease?.lastFailure?.workerRunId)
  ) return null;
  const jobs = await listJobs({ repository: orchestratorRepository, runId: recoveredWorkerRun.id, token: actionsToken });
  const matching = jobs.filter((job) => (job.steps ?? []).some((step) =>
    String(step?.name ?? '') === 'Validate controller-authorized material scope'
    && String(step?.conclusion ?? '') === 'failure'
  ));
  if (matching.length !== 1) return null;
  return Object.freeze({
    classification: 'material-scope-guard-rejected-local-patch',
    workerRunId: Number(recoveredWorkerRun.id),
    evidenceRef: matching[0].html_url ?? recoveredWorkerRun.html_url ?? null
  });
}

export function rearmSuccessfulBootstrapAfterIssueContractChange(
  lease,
  decision,
  { currentControllerRunId, currentControllerHeadSha } = {}
) {
  if (decision?.recovery?.reason !== 'issue-contract-changed-after-successful-pre-material-worker-without-pr') return null;
  if (lease?.status !== 'reserved-initial-attempt') {
    throw new Error('issue-contract recovery requires reserved-initial-attempt state');
  }

  const activeControllerRunId = positiveInteger(currentControllerRunId, 'currentControllerRunId');
  const currentHeadSha = normalizedSha(currentControllerHeadSha);
  if (!currentHeadSha) throw new Error('currentControllerHeadSha must be an exact Git commit SHA');

  const dispatchNonce = String(decision.dispatchNonce ?? '').trim();
  if (!dispatchNonce) throw new Error('issue-contract bootstrap recovery requires dispatch nonce');

  const scopeBinding = lease.scopeBinding;
  if (!scopeBinding || typeof scopeBinding !== 'object' || Array.isArray(scopeBinding)) {
    throw new Error('issue-contract bootstrap recovery requires persisted scope binding');
  }
  if (Number(scopeBinding.schemaVersion) !== 1) {
    throw new Error('issue-contract bootstrap recovery requires scope binding schemaVersion 1');
  }
  if (
    String(scopeBinding.repository ?? '') !== String(lease.repository ?? '')
    || Number(scopeBinding.issueNumber) !== Number(lease.issueNumber)
  ) {
    throw new Error('issue-contract bootstrap recovery scope binding target mismatch');
  }

  const previousIssueContractSha256 = normalizedFingerprint(
    scopeBinding.issueContractSha256
  );
  const expectedPrevious = normalizedFingerprint(
    decision.recovery.previousIssueContractSha256
  );
  const currentIssueContractSha256 = normalizedFingerprint(
    decision.recovery.currentIssueContractSha256
  );
  if (
    !previousIssueContractSha256
    || previousIssueContractSha256 !== expectedPrevious
    || !currentIssueContractSha256
    || currentIssueContractSha256 === previousIssueContractSha256
  ) {
    throw new Error('issue-contract bootstrap recovery fingerprint provenance mismatch');
  }

  const { commentId, ...value } = lease;
  const previousControllerRunId = positiveInteger(
    value.controllerRunId,
    'bootstrap controllerRunId'
  );
  const controllerRunHistory = [...new Set([
    ...(Array.isArray(value.controllerRunHistory) ? value.controllerRunHistory : []),
    previousControllerRunId
  ].map(Number).filter((item) => Number.isInteger(item) && item > 0 && item !== activeControllerRunId))];

  const previousHeadSha = normalizedSha(value.controllerHeadSha);
  const controllerProvenanceHistory = [
    ...(Array.isArray(value.controllerProvenanceHistory) ? value.controllerProvenanceHistory : []),
    ...(previousControllerRunId !== activeControllerRunId
      ? [{ controllerRunId: previousControllerRunId, controllerHeadSha: previousHeadSha }]
      : [])
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          Number(candidate?.controllerRunId) === Number(entry?.controllerRunId)
          && String(candidate?.controllerHeadSha ?? '') === String(entry?.controllerHeadSha ?? '')
      ) === index
  );

  return Object.freeze({
    ...value,
    status: 'reserved-initial-attempt',
    controllerRunId: activeControllerRunId,
    controllerRunHistory,
    controllerProvenanceHistory,
    controllerHeadSha: currentHeadSha,
    workerRunId: null,
    dispatchNonce,
    scopeBinding: Object.freeze({
      ...scopeBinding,
      issueContractSha256: currentIssueContractSha256
    }),
    recovery: Object.freeze({
      ...decision.recovery,
      previousWorkerRunId: value.workerRunId ?? null,
      previousDispatchNonce: value.dispatchNonce ?? null
    })
  });
}

export function buildReentryGuardFailure(error, {
  repository = null,
  issueNumber = null,
  pullRequest = null,
  bootstrapLease = null
} = {}) {
  const explicitClassification = error?.bootstrapClassification
    ? {
        status: error.bootstrapStatus ?? null,
        classification: error.bootstrapClassification,
        reason: error.bootstrapReason ?? 'bootstrap-classification-failed'
      }
    : classifyLegacyAdoptionBootstrap(bootstrapLease);
  const identity = error?.targetIdentity ?? null;
  return Object.freeze({
    schemaVersion: 1,
    status: 'reentry-guard-failed',
    repository,
    issueNumber,
    pullRequestNumber: identity?.pullRequestNumber ?? pullRequest?.number ?? null,
    materialHeadSha: identity?.materialHeadSha ?? pullRequest?.head?.sha ?? null,
    reentry: {
      bootstrapStatus: explicitClassification.status,
      bootstrapClassification: explicitClassification.classification,
      reason: explicitClassification.reason,
      adoptionPersisted: error?.adoptionPersisted === true,
      retryPersisted: false
    },
    error: {
      code: error?.code ?? 'REENTRY_GUARD_ERROR',
      message: String(error?.message ?? error)
    }
  });
}

export async function recordReentryGuardFailure(error, context = error?.reentryGuardContext ?? {}) {
  const resultPath = String(process.env.CONTROLLER_RESULT_PATH ?? '').trim();
  const errorPath = String(process.env.CONTROLLER_ERROR_PATH ?? '').trim();
  if (!resultPath && !errorPath) return;
  const repository = String(context.repository ?? process.env.TARGET_REPOSITORY ?? '').trim() || null;
  const rawIssue = Number(context.issueNumber ?? process.env.TARGET_ISSUE);
  const payload = buildReentryGuardFailure(error, {
    repository,
    issueNumber: Number.isInteger(rawIssue) && rawIssue > 0 ? rawIssue : null,
    pullRequest: context.pullRequest ?? null,
    bootstrapLease: context.bootstrapLease ?? null
  });
  if (resultPath) await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (errorPath) await appendFile(errorPath, `${JSON.stringify(payload)}\n`, 'utf8');
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
    `dispatch_nonce=${decision.dispatchNonce ?? ''}`,
    `reuse_reserved_attempt=${decision.reuseReservedAttempt ? 'true' : 'false'}`,
    `adoption_head=${decision.adoption ? decision.materialHeadSha : ''}`,
    `recovery_reason=${decision.recovery?.reason ?? ''}`,
    `recovery_previous_attempts=${decision.recovery?.previousImplementationAttempts ?? ''}`,
    `recovery_previous_controller_sha=${decision.recovery?.previousControllerHeadSha ?? ''}`,
    `recovery_current_controller_sha=${decision.recovery?.currentControllerHeadSha ?? ''}`
  ].join('\n');
  await appendFile(outputPath, `${lines}\n`, 'utf8');
}

export function terminalBootstrapLease(
  lease,
  decision,
  recoveredWorkerRun,
  currentControllerHeadSha = null
) {
  if (decision.status !== 'escalated-initial-budget-exhausted') return null;

  const { commentId, ...value } = lease;
  const controllerHeadSha = normalizedSha(
    value.recovery?.currentControllerHeadSha
      ?? value.controllerHeadSha
      ?? currentControllerHeadSha
  );

  return {
    ...value,
    ...(controllerHeadSha ? { controllerHeadSha } : {}),
    status: decision.status,
    workerRunId: recoveredWorkerRun?.id ?? value.workerRunId,
    failureClass: value.lastFailure?.failureClass ?? (
      ['timed_out', 'startup_failure', 'cancelled'].includes(
        recoveredWorkerRun?.conclusion
      ) ? 'infrastructure' : 'unknown'
    ),
    failureStage: value.lastFailure?.failureStage ?? 'pre-material',
    workerConclusion: value.lastFailure?.workerConclusion ?? recoveredWorkerRun?.conclusion ?? null
  };
}

// Resolve write capability only after a concrete mutation has been selected.
export async function persistReentryMutation({ decision, adoptionEnvelope, bootstrapLease, recoveredWorkerRun, repository, controller,
  currentControllerRunId = null, currentControllerHeadSha = null, getWriteToken = () => requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN'), mutate = api }) {
  let url;
  let method;
  let body;
  if (decision.adoption) {
    if (decision.adoption.repository !== repository) throw new Error('adoption mutation repository mismatch');
    if (adoptionEnvelope && JSON.stringify(adoptionEnvelope.adoption) === JSON.stringify(decision.adoption)) return false;
    url = adoptionEnvelope ? `https://api.github.com/repos/${repository}/issues/comments/${adoptionEnvelope.commentId}` : `https://api.github.com/repos/${repository}/issues/${decision.pullRequestNumber}/comments`;
    method = adoptionEnvelope ? 'PATCH' : 'POST';
    body = legacyAdoptionComment(decision.adoption, controller);
  } else {
    const rearmedIssueContract = bootstrapLease && rearmSuccessfulBootstrapAfterIssueContractChange(
      bootstrapLease,
      decision,
      { currentControllerRunId, currentControllerHeadSha }
    );
    const rearmedLegacy = !rearmedIssueContract && bootstrapLease && rearmLegacyNonrecoverableBootstrapLease(
      bootstrapLease,
      decision,
      { currentControllerRunId, currentControllerHeadSha }
    );
    const rearmed = rearmedIssueContract ?? rearmedLegacy;
    const terminal = rearmed ?? (bootstrapLease && terminalBootstrapLease(
      bootstrapLease,
      decision,
      recoveredWorkerRun,
      currentControllerHeadSha
    ));
    if (!terminal || (!rearmed && bootstrapLease.status === terminal.status)) return false;
    if (bootstrapLease.repository !== repository) throw new Error('bootstrap mutation repository mismatch');
    url = `https://api.github.com/repos/${repository}/issues/comments/${positiveInteger(bootstrapLease.commentId, 'bootstrap commentId')}`;
    method = 'PATCH';
    body = `${BOOTSTRAP_MARKER}\n## Delivery V2 bootstrap state\n\n\`\`\`json\n${JSON.stringify(terminal, null, 2)}\n\`\`\``;
  }
  await mutate(url, getWriteToken(), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  return true;
}

export async function ensureLegacyAdoptionPullRequestTitle({ decision, pullRequest, repository,
  getWriteToken = () => requiredEnv('DELIVERY_GITHUB_WRITE_TOKEN'), mutate = api } = {}) {
  if (!decision?.adoption) return false;
  if (decision.adoption.repository !== repository) throw new Error('adoption title mutation repository mismatch');
  if (!pullRequest || Number(pullRequest.number) !== Number(decision.pullRequestNumber)) throw new Error('adoption title mutation PR mismatch');
  const remoteHeadSha = String(pullRequest?.head?.sha ?? '').trim().toLowerCase();
  if (remoteHeadSha !== String(decision.adoption.materialHeadSha ?? '').trim().toLowerCase()) throw new Error('adoption title mutation head mismatch');
  const currentTitle = String(pullRequest.title ?? '').trim();
  if (!currentTitle) throw new Error('adoption title mutation requires current PR title');
  if (currentTitle.startsWith('[delivery-v2] ')) return false;
  const url = `https://api.github.com/repos/${repository}/pulls/${positiveInteger(decision.pullRequestNumber, 'decision.pullRequestNumber')}`;
  await mutate(url, getWriteToken(), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `[delivery-v2] ${currentTitle}` })
  });
  return true;
}

async function main() {
  const targetRepository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger(requiredEnv('TARGET_ISSUE'), 'TARGET_ISSUE');
  const baseBranch = requiredEnv('BASE_BRANCH');
  requiredEnv('DELIVERY_AI_PROVIDER');
  const readToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const actionsToken = requiredEnv('GITHUB_TOKEN');
  const orchestratorRepository = requiredEnv('GITHUB_REPOSITORY');
  const orchestratorRef = requiredEnv('ORCHESTRATOR_WORKER_REF');
  const resultPath = String(process.env.CONTROLLER_RESULT_PATH ?? '').trim();
  const currentControllerHeadSha = resolveCheckedOutControlPlaneHeadSha();
  const currentControllerRunId = positiveInteger(requiredEnv('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');

  const trustedLogin = trustedCommentAuthorForRepository(targetRepository);
  const pulls = await listOpenPullRequests(targetRepository, readToken);
  const pullRequest = selectManagedPullRequest(pulls, { issueNumber, baseBranch, trustedLogin, repository: targetRepository });
  let stateEnvelope = null;
  let adoptionEnvelope = null;
  let bootstrapLease = null;
  if (pullRequest) {
    const comments = await listIssueComments(targetRepository, pullRequest.number, readToken);
    stateEnvelope = parsePersistentStateEnvelope(comments, { trustedLogin });
    adoptionEnvelope = parseLegacyAdoptionEnvelope(comments, targetRepository);
  }
  if (!stateEnvelope && !adoptionEnvelope) bootstrapLease = parseBootstrapLease(await listIssueComments(targetRepository, issueNumber, readToken), { trustedLogin });

  const provenance = stateEnvelope?.controller ?? adoptionEnvelope?.controller ?? bootstrapLease;
  let provenanceControllerRun = null;
  if (provenance) {
    const controllerRunId = positiveInteger(provenance.controllerRunId, 'controllerRunId');
    provenanceControllerRun = await api(`https://api.github.com/repos/${orchestratorRepository}/actions/runs/${controllerRunId}`, actionsToken);
    validateControllerRunProvenance(provenanceControllerRun, { orchestratorRepository, trustedRef: orchestratorRef });
    if (adoptionEnvelope && !stateEnvelope) validateLegacyAdoptionControllerRun(adoptionEnvelope, provenanceControllerRun, { orchestratorRepository, trustedRef: orchestratorRef });
  }

  const bootstrapControllerHeadSha =
    bootstrapLease && provenanceControllerRun
      ? await resolveBootstrapControllerHeadShaFromRun({
          bootstrapLease,
          controllerRun: provenanceControllerRun,
          orchestratorRepository,
          trustedRef: orchestratorRef,
          actionsToken
        })
      : null;

  const currentIssue = bootstrapLease
    ? await api(`https://api.github.com/repos/${targetRepository}/issues/${issueNumber}`, readToken)
    : null;
  const currentIssueContractSha256 = currentIssue
    ? issueContractFingerprint({
        repository: targetRepository,
        issueNumber,
        title: currentIssue.title,
        body: currentIssue.body
      })
    : null;
  const recoveredWorkerRun = bootstrapLease ? await recoverBootstrapWorkerRun(bootstrapLease, orchestratorRepository, orchestratorRef, actionsToken) : null;
  const scopeGuardFailure = bootstrapLease
    ? await detectMaterialScopeGuardFailure({
        bootstrapLease,
        recoveredWorkerRun,
        orchestratorRepository,
        actionsToken
      })
    : null;
  const patchArtifact = scopeGuardFailure
    ? await downloadGhAwAgentOutputArtifact({
        repository: orchestratorRepository,
        runId: recoveredWorkerRun.id,
        token: actionsToken
      })
    : null;
  const observedPatch = patchArtifact
    ? Object.freeze({
        hasPatch: patchArtifact.hasPatch,
        changedPaths: patchArtifact.changedPaths,
        materialPublished: pullRequest !== null,
        evidenceRef: patchArtifact.evidenceRef
      })
    : null;
  const correctedScopeBinding = scopeGuardFailure && currentIssue
    ? createWorkerScopeBinding({
        repository: targetRepository,
        issue: currentIssue,
        authorizedPaths: loadV2Config({}, process.env).changedPaths
      })
    : null;
  const legacyAuthorizationFailure = bootstrapLease
    ? await detectLegacyBootstrapControllerRunMismatch({
        bootstrapLease,
        recoveredWorkerRun,
        orchestratorRepository,
        actionsToken
      })
    : null;
  const effectiveRisk = stateEnvelope?.persistent?.effectiveRisk ?? bootstrapLease?.effectiveRisk ?? 'critical';
  const aiPolicy = loadV2Config({}, process.env).aiPolicy;
  const expectedImplementer = resolveProviderSelectionForRisk(aiPolicy, effectiveRisk).implementer;
  let decision;
  try {
    decision = evaluateReentry({
      pullRequest,
      stateEnvelope,
      adoptionEnvelope,
      bootstrapLease,
      targetRepository,
      issueNumber,
      baseBranch,
      provider: expectedImplementer.provider,
      model: expectedImplementer.model,
      recoveredWorkerRun,
      bootstrapControllerHeadSha,
      currentControllerHeadSha,
      currentIssueContractSha256,
      legacyAuthorizationFailure,
      scopeGuardFailure,
      observedPatch,
      correctedScopeBinding,
      rearmDispatchNonce: (legacyAuthorizationFailure || scopeGuardFailure || (bootstrapLease && recoveredWorkerRun?.status === 'completed' && recoveredWorkerRun?.conclusion === 'success')) ? createDispatchNonce() : null
    });
  } catch (error) {
    error.reentryGuardContext = {
      repository: targetRepository,
      issueNumber,
      pullRequest,
      bootstrapLease
    };
    throw error;
  }
  await persistReentryMutation({
    decision, adoptionEnvelope, bootstrapLease, recoveredWorkerRun, repository: targetRepository,
    currentControllerRunId,
    currentControllerHeadSha,
    controller: decision.adoption ? {
      controllerRunId: currentControllerRunId,
      controllerRepository: orchestratorRepository, controllerRef: orchestratorRef,
      controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml'
    } : null
  });
  await ensureLegacyAdoptionPullRequestTitle({ decision, pullRequest, repository: targetRepository });
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
  main().catch(async (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
    await recordReentryGuardFailure(error).catch((recordError) => {
      process.stderr.write(`failed to record structured reentry guard error: ${recordError.message}\n`);
    });
    await recordControllerTechnicalError(error, { source: 'reentry-guard' }).catch((recordError) => {
      process.stderr.write(`failed to record reentry guard technical error: ${recordError.message}\n`);
    });
  });
}
