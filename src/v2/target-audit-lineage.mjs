import { createHash } from 'node:crypto';

import {
  buildTargetCriticalAuditRequest,
  normalizeTargetAuditConfig
} from './target-independent-audit-runtime.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const TARGET_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const STATE_PREFIX = '<!-- delivery-v2-target-audit-state:';
const CONTROL_WORKFLOW_NAME = 'Delivery V2 Independent Audit';
const CONTROL_WORKFLOW_PATH = '.github/workflows/delivery-v2-independent-audit.yml';
const CONTROL_WORKFLOW_EVENT = 'workflow_run';
const CONTROL_TARGET_JOB_NAME = 'Independent target CRITICAL semantic audit';
const CONTROL_ENFORCEMENT_STEP_NAME = 'Enforce target audit decision';

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function positiveInt(value, label) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function sha(value, label) {
  const resolved = string(value, label).toLowerCase();
  if (!SHA_RE.test(resolved)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return resolved;
}

function fingerprint(value, label) {
  const resolved = string(value, label).toLowerCase();
  if (!FINGERPRINT_RE.test(resolved)) throw new Error(`${label} must be a 64-character SHA-256 fingerprint`);
  return resolved;
}

function repository(value, label) {
  const resolved = string(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolved)) throw new Error(`${label} must use owner/name form`);
  return resolved;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function canonicalFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-target-audit-lineage'
  };
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.json();
}

export function computeTargetAuditReleaseGate({ result, outcome }) {
  const normalizedResult = object(result, 'audit result');
  const normalizedOutcome = object(outcome, 'audit outcome');
  if (!Array.isArray(normalizedResult.findings)) throw new Error('audit result findings must be an array');
  const semanticDecision = string(normalizedResult.decision, 'audit result decision');
  if (!['approved', 'rejected'].includes(semanticDecision)) throw new Error('audit result decision must be approved or rejected');
  const releaseBlocked = boolean(normalizedOutcome.releaseBlocked, 'audit outcome releaseBlocked');
  const blockingFindingCount = normalizedResult.findings.filter((finding) => finding?.blocksRelease === true).length;
  const passed = semanticDecision === 'approved' && releaseBlocked === false && blockingFindingCount === 0;
  return Object.freeze({
    passed,
    durableDecision: passed ? 'approved' : 'rejected',
    semanticDecision,
    releaseBlocked,
    blockingFindingCount
  });
}

export function normalizePersistedTargetAuditState(raw, commentId) {
  const value = object(raw, `target audit state in comment ${commentId}`);
  if (value.schemaVersion !== 3) throw new Error(`target audit state in comment ${commentId} has unsupported schemaVersion`);
  const targetAuditId = string(value.targetAuditId, `target audit state ${commentId} targetAuditId`).toLowerCase();
  if (!TARGET_ID_RE.test(targetAuditId)) throw new Error(`target audit state in comment ${commentId} has invalid targetAuditId`);
  const publisher = object(value.publisher, `target audit state ${commentId} publisher`);
  if (!Array.isArray(value.findings)) throw new Error(`target audit state in comment ${commentId} findings must be an array`);
  const findings = Object.freeze(value.findings.map((finding) => Object.freeze({ ...object(finding, `target audit state ${commentId} finding`) })));
  const semanticDecision = string(value.semanticDecision, `target audit state ${commentId} semanticDecision`);
  const decision = string(value.decision, `target audit state ${commentId} decision`);
  if (!['approved', 'rejected'].includes(semanticDecision) || !['approved', 'rejected'].includes(decision)) {
    throw new Error(`target audit state in comment ${commentId} has invalid decision`);
  }
  const releaseBlocked = boolean(value.releaseBlocked, `target audit state ${commentId} releaseBlocked`);
  const blockingFindingCount = positiveIntOrZero(value.blockingFindingCount, `target audit state ${commentId} blockingFindingCount`);
  const actualBlocking = findings.filter((finding) => finding.blocksRelease === true).length;
  if (blockingFindingCount !== actualBlocking) throw new Error(`target audit state in comment ${commentId} blockingFindingCount disagrees with findings`);
  const releaseGatePassed = boolean(value.releaseGatePassed, `target audit state ${commentId} releaseGatePassed`);
  const expectedGate = semanticDecision === 'approved' && releaseBlocked === false && actualBlocking === 0;
  if (releaseGatePassed !== expectedGate) throw new Error(`target audit state in comment ${commentId} releaseGatePassed disagrees with deterministic gate`);
  const expectedDecision = expectedGate ? 'approved' : 'rejected';
  if (decision !== expectedDecision) throw new Error(`target audit state in comment ${commentId} durable decision disagrees with deterministic gate`);

  return Object.freeze({
    schemaVersion: 3,
    controlRepository: repository(value.controlRepository, `target audit state ${commentId} controlRepository`),
    targetAuditId,
    targetRepository: repository(value.targetRepository, `target audit state ${commentId} targetRepository`),
    issueNumber: positiveInt(value.issueNumber, `target audit state ${commentId} issueNumber`),
    pullRequestNumber: positiveInt(value.pullRequestNumber, `target audit state ${commentId} pullRequestNumber`),
    baseRef: string(value.baseRef, `target audit state ${commentId} baseRef`),
    headRef: string(value.headRef, `target audit state ${commentId} headRef`),
    candidateSha: sha(value.candidateSha, `target audit state ${commentId} candidateSha`),
    mergePreviewSha: sha(value.mergePreviewSha, `target audit state ${commentId} mergePreviewSha`),
    mergeCommitSha: sha(value.mergeCommitSha, `target audit state ${commentId} mergeCommitSha`),
    auditWorkflowRunId: positiveInt(value.auditWorkflowRunId, `target audit state ${commentId} auditWorkflowRunId`),
    sourceWorkflowRunId: positiveInt(value.sourceWorkflowRunId, `target audit state ${commentId} sourceWorkflowRunId`),
    auditAttempt: positiveInt(value.auditAttempt, `target audit state ${commentId} auditAttempt`),
    implementationAttempt: positiveInt(value.implementationAttempt, `target audit state ${commentId} implementationAttempt`),
    semanticDecision,
    decision,
    releaseBlocked,
    blockingFindingCount,
    releaseGatePassed,
    requestFingerprint: fingerprint(value.requestFingerprint, `target audit state ${commentId} requestFingerprint`),
    runtimeSha: sha(value.runtimeSha, `target audit state ${commentId} runtimeSha`),
    publisher: Object.freeze({
      workflowName: string(publisher.workflowName, `target audit state ${commentId} publisher.workflowName`),
      workflowPath: string(publisher.workflowPath, `target audit state ${commentId} publisher.workflowPath`),
      event: string(publisher.event, `target audit state ${commentId} publisher.event`)
    }),
    findings,
    commentId: positiveInt(commentId, 'commentId')
  });
}

function positiveIntOrZero(value, label) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${label} must be a non-negative integer`);
  return resolved;
}

function sameStaticSubject(config, state) {
  return state.targetRepository === config.repository && state.issueNumber === config.issueNumber;
}

export function deriveTargetAuditProgress(configInput, states) {
  const config = normalizeTargetAuditConfig(configInput);
  if (!Array.isArray(states)) throw new Error('persisted target audit states must be an array');
  const relevant = states.filter((state) => sameStaticSubject(config, state));
  for (const state of relevant) {
    if (state.targetAuditId !== config.id) {
      throw new Error(`target audit lineage identifier changed for ${config.repository}#${config.pullRequestNumber}; reuse ${state.targetAuditId}`);
    }
  }
  const ordered = [...relevant].sort((left, right) => left.auditAttempt - right.auditAttempt || left.auditWorkflowRunId - right.auditWorkflowRunId);
  ordered.forEach((state, index) => {
    const expectedAttempt = index + 1;
    if (state.auditAttempt !== expectedAttempt || state.implementationAttempt !== expectedAttempt) {
      throw new Error(`durable target audit lineage for ${config.id} has a non-sequential attempt history`);
    }
  });
  if (ordered.some((state) => state.candidateSha === config.materialHeadSha)) {
    throw new Error(`target candidate ${config.materialHeadSha} already has authoritative durable audit state; a new material SHA is required before re-audit`);
  }

  const priorFindings = [];
  const seen = new Set();
  for (const state of ordered) {
    for (const finding of state.findings) {
      const id = String(finding.id ?? '').trim();
      if (!id) continue;
      const key = `${state.candidateSha}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      priorFindings.push(Object.freeze({
        id,
        candidateSha: state.candidateSha,
        status: state.decision === 'rejected' ? 'previous-rejection' : 'previous-audit'
      }));
    }
  }

  const nextAttempt = ordered.length + 1;
  return Object.freeze({
    lineageId: config.id,
    auditAttempt: nextAttempt,
    implementationAttempt: nextAttempt,
    priorFindings: Object.freeze(priorFindings),
    priorStates: Object.freeze(ordered)
  });
}

async function controllerRunMatchesDurableGate(state, controlRepository, token) {
  const run = await fetchJson(`https://api.github.com/repos/${controlRepository}/actions/runs/${state.auditWorkflowRunId}`, token);
  if (String(run?.repository?.full_name ?? '') !== controlRepository) throw new Error(`target audit state comment ${state.commentId} references a workflow run from another repository`);
  if (String(run?.name ?? '') !== CONTROL_WORKFLOW_NAME || String(run?.path ?? '') !== CONTROL_WORKFLOW_PATH || String(run?.event ?? '') !== CONTROL_WORKFLOW_EVENT) {
    throw new Error(`target audit state comment ${state.commentId} references a non-controller workflow run`);
  }
  if (String(run?.status ?? '') !== 'completed') return false;

  const jobs = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchJson(`https://api.github.com/repos/${controlRepository}/actions/runs/${state.auditWorkflowRunId}/jobs?filter=latest&per_page=100&page=${page}`, token);
    const pageJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
  }
  const targetJobs = jobs.filter((job) => String(job?.name ?? '') === CONTROL_TARGET_JOB_NAME);
  if (targetJobs.length !== 1) return false;
  const enforceSteps = Array.isArray(targetJobs[0].steps)
    ? targetJobs[0].steps.filter((step) => String(step?.name ?? '') === CONTROL_ENFORCEMENT_STEP_NAME)
    : [];
  if (enforceSteps.length !== 1 || String(enforceSteps[0].status ?? '') !== 'completed') return false;
  const expectedConclusion = state.releaseGatePassed ? 'success' : 'failure';
  if (String(enforceSteps[0].conclusion ?? '') !== expectedConclusion) return false;
  if (String(run?.conclusion ?? '') !== expectedConclusion) return false;
  return true;
}

async function assertControllerOwnedStateComment(comment, state, controlRepository, token) {
  if (state.controlRepository !== controlRepository) throw new Error(`target audit state comment ${comment.id} belongs to another control repository`);
  if (state.publisher.workflowName !== CONTROL_WORKFLOW_NAME || state.publisher.workflowPath !== CONTROL_WORKFLOW_PATH || state.publisher.event !== CONTROL_WORKFLOW_EVENT) {
    throw new Error(`target audit state comment ${comment.id} declares an untrusted publisher`);
  }
  const expectedMarker = `<!-- delivery-v2-target-independent-audit:${state.targetAuditId}:${state.candidateSha}:${state.auditWorkflowRunId} -->`;
  if (!String(comment.body ?? '').includes(expectedMarker)) throw new Error(`target audit state comment ${comment.id} is missing its exact workflow-run marker`);
  const authoritative = await controllerRunMatchesDurableGate(state, controlRepository, token);
  if (!authoritative) return false;

  const run = await fetchJson(`https://api.github.com/repos/${controlRepository}/actions/runs/${state.auditWorkflowRunId}`, token);
  const commentTime = Date.parse(String(comment?.created_at ?? ''));
  const runStart = Date.parse(String(run?.run_started_at ?? run?.created_at ?? ''));
  const runEnd = Date.parse(String(run?.updated_at ?? ''));
  if (![commentTime, runStart, runEnd].every(Number.isFinite) || commentTime < runStart - 60_000 || commentTime > runEnd + 60_000) {
    throw new Error(`target audit state comment ${comment.id} timestamp is not bound to the referenced controller workflow run`);
  }
  return true;
}

export async function fetchControllerOwnedTargetAuditStates({ controlRepository, issueNumber, token }) {
  const repositoryName = repository(controlRepository, 'controlRepository');
  const issue = positiveInt(issueNumber, 'issueNumber');
  const authToken = string(token, 'token');
  const states = [];
  for (let page = 1; ; page += 1) {
    const comments = await fetchJson(`https://api.github.com/repos/${repositoryName}/issues/${issue}/comments?per_page=100&page=${page}`, authToken);
    if (!Array.isArray(comments)) throw new Error('target audit state comments response must be an array');
    for (const comment of comments) {
      if (String(comment?.user?.login ?? '') !== 'github-actions[bot]' || String(comment?.user?.type ?? '') !== 'Bot') continue;
      const body = String(comment?.body ?? '');
      if (!body.includes(STATE_PREFIX)) continue;
      const matches = [...body.matchAll(/<!-- delivery-v2-target-audit-state:([A-Za-z0-9_-]+) -->/g)];
      if (matches.length !== 1) throw new Error(`target audit state comment ${comment.id} has malformed or ambiguous state marker`);
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
      } catch (error) {
        throw new Error(`target audit state comment ${comment.id} cannot be decoded: ${error.message}`);
      }
      if (parsed?.schemaVersion !== 3) {
        process.stderr.write(`Ignoring legacy target audit state comment ${comment.id}: deterministic release-gate coherence is not attestable.\n`);
        continue;
      }
      const state = normalizePersistedTargetAuditState(parsed, Number(comment.id));
      if (!await assertControllerOwnedStateComment(comment, state, repositoryName, authToken)) {
        process.stderr.write(`Ignoring non-authoritative target audit state comment ${comment.id}: workflow conclusion/enforcement does not attest its release gate.\n`);
        continue;
      }
      states.push(state);
    }
    if (comments.length < 100) break;
  }
  const runIds = states.map((state) => state.auditWorkflowRunId);
  if (new Set(runIds).size !== runIds.length) throw new Error('durable target audit state contains duplicate audit workflow run ids');
  return Object.freeze(states);
}

export function buildLineageTargetCriticalAuditRequest(args = {}) {
  const config = normalizeTargetAuditConfig(args.config);
  const baseRequest = buildTargetCriticalAuditRequest(args);
  const { requestFingerprint: _discard, ...withoutFingerprint } = baseRequest;
  const lineageRuntimeFingerprint = fingerprint(args.auditRuntimeEvidence?.lineageRuntimeFingerprint, 'auditRuntimeEvidence.lineageRuntimeFingerprint');
  const requestBody = {
    ...withoutFingerprint,
    targetAudit: Object.freeze({
      ...baseRequest.targetAudit,
      runtime: Object.freeze({ ...baseRequest.targetAudit.runtime, lineageRuntimeFingerprint }),
      lineageId: config.id,
      lineageSubject: Object.freeze({
        repository: config.repository,
        issueNumber: config.issueNumber
      }),
      executionIdentity: Object.freeze({
        pullRequestNumber: config.pullRequestNumber,
        baseRef: config.baseRef,
        baseSha: config.baseSha,
        headRef: config.headRef,
        candidateSha: config.materialHeadSha,
        mergePreviewSha: config.mergePreviewSha,
        mergeCommitSha: config.mergeCommitSha,
        sourceWorkflowRunId: config.sourceWorkflow.runId
      })
    })
  };
  return Object.freeze({ ...requestBody, requestFingerprint: canonicalFingerprint(requestBody) });
}
