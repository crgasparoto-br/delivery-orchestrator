#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CodexExecutor } from '../src/codex-executor.mjs';
import {
  finalizeIndependentAuditResult,
  independentAuditModelOutputSchema
} from '../src/v2/independent-audit-runtime.mjs';
import {
  buildTargetCriticalAuditRequest,
  normalizeTargetAuditConfig
} from '../src/v2/target-independent-audit-runtime.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const STATE_PREFIX = '<!-- delivery-v2-target-audit-state:';
const CONTROL_WORKFLOW_NAME = 'Delivery V2 Independent Audit';
const CONTROL_WORKFLOW_PATH = '.github/workflows/delivery-v2-independent-audit.yml';
const CONTROL_WORKFLOW_EVENT = 'workflow_run';

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function requiredSha(value, label) {
  const resolved = String(value ?? '').trim().toLowerCase();
  if (!SHA_RE.test(resolved)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return resolved;
}
function requiredFingerprint(value, label) {
  const resolved = String(value ?? '').trim().toLowerCase();
  if (!FINGERPRINT_RE.test(resolved)) throw new Error(`${label} must be a 64-character SHA-256 fingerprint`);
  return resolved;
}
function fingerprintText(content) {
  return createHash('sha256').update(String(content)).digest('hex');
}
function apiHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-target-independent-auditor'
  };
}
async function fetchJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.json();
}
async function fetchText(url, token, accept = 'application/vnd.github+json') {
  const response = await fetch(url, { headers: apiHeaders(token, accept), redirect: 'follow' });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.text();
}
function safeRepositoryPath(value, label) {
  const raw = String(value ?? '').replaceAll('\\', '/').trim();
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!raw || path.posix.isAbsolute(raw) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} is not a safe repository-relative path`);
  }
  return normalized;
}

async function fetchFileEvidenceAtRef(repository, filePath, ref, token, { allowMissing = false } = {}) {
  const safePath = safeRepositoryPath(filePath, 'repository file path');
  const encoded = safePath.split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ ref });
  const url = `https://api.github.com/repos/${repository}/contents/${encoded}?${query}`;
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  const payload = await response.json();
  if (payload.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error(`complete base64 file snapshot is unavailable for ${safePath}@${ref}`);
  }
  if (payload.path !== safePath) throw new Error(`GitHub content path mismatch for ${safePath}@${ref}`);
  const bytes = Buffer.from(payload.content, 'base64');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`changed file ${safePath}@${ref} is not lossless UTF-8 text evidence`);
  return Object.freeze({
    ref: String(ref).toLowerCase(),
    path: safePath,
    blobSha: requiredSha(payload.sha, `file ${safePath} blob SHA`),
    size: bytes.length,
    contentFingerprint: createHash('sha256').update(bytes).digest('hex'),
    content
  });
}

async function fetchChangedFileEvidence(repository, pullRequestNumber, baseSha, headSha, token) {
  const rawFiles = [];
  for (let page = 1; ; page += 1) {
    const pageFiles = await fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, token);
    if (!Array.isArray(pageFiles)) throw new Error('GitHub changed-file response must be an array');
    rawFiles.push(...pageFiles);
    if (pageFiles.length < 100) break;
  }
  if (rawFiles.length === 0) throw new Error('target audit changed-file inventory must be non-empty');

  const files = [];
  for (const [index, file] of rawFiles.entries()) {
    const filename = safeRepositoryPath(file?.filename, `changed file ${index} filename`);
    const previousFilename = file?.previous_filename ? safeRepositoryPath(file.previous_filename, `changed file ${filename} previous filename`) : null;
    const status = String(file?.status ?? '').trim().toLowerCase();
    if (!['added', 'modified', 'removed', 'renamed'].includes(status)) throw new Error(`unsupported changed-file status ${status} for ${filename}`);
    const basePath = status === 'renamed' ? previousFilename : filename;
    if (status === 'renamed' && !basePath) throw new Error(`renamed changed file ${filename} is missing previous_filename`);

    const base = status === 'added' ? null : await fetchFileEvidenceAtRef(repository, basePath, baseSha, token, { allowMissing: false });
    const head = status === 'removed' ? null : await fetchFileEvidenceAtRef(repository, filename, headSha, token, { allowMissing: false });
    if (status === 'added' && await fetchFileEvidenceAtRef(repository, filename, baseSha, token, { allowMissing: true }) !== null) {
      throw new Error(`added changed file ${filename} unexpectedly exists at base SHA`);
    }
    if (status === 'removed' && await fetchFileEvidenceAtRef(repository, filename, headSha, token, { allowMissing: true }) !== null) {
      throw new Error(`removed changed file ${filename} unexpectedly exists at head SHA`);
    }
    if (head && requiredSha(file.sha, `changed file ${filename} GitHub blob SHA`) !== head.blobSha) {
      throw new Error(`changed file ${filename} head blob does not match GitHub changed-file inventory`);
    }

    const summarize = (snapshot) => snapshot == null ? null : Object.freeze({
      ref: snapshot.ref,
      path: snapshot.path,
      blobSha: snapshot.blobSha,
      size: snapshot.size,
      contentFingerprint: snapshot.contentFingerprint
    });
    files.push(Object.freeze({
      filename,
      previousFilename,
      status,
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      changes: Number(file.changes ?? 0),
      base: summarize(base),
      head: summarize(head),
      snapshots: Object.freeze({ base, head })
    }));
  }

  const paths = files.map((file) => file.filename);
  if (new Set(paths).size !== paths.length) throw new Error('target audit changed-file inventory contains duplicate filenames');
  const manifest = files.map(({ snapshots: _snapshots, ...file }) => file);
  const inventoryFingerprint = fingerprintText(JSON.stringify(manifest.map((file) => ({
    filename: file.filename,
    previousFilename: file.previousFilename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes
  }))));
  const snapshotFingerprint = fingerprintText(JSON.stringify(manifest));
  return Object.freeze({
    files: Object.freeze(files),
    manifest: Object.freeze(manifest),
    paths: Object.freeze(paths),
    evidence: Object.freeze({
      fileCount: files.length,
      paths: Object.freeze(paths),
      allSnapshotsPresent: true,
      inventoryFingerprint,
      snapshotFingerprint
    })
  });
}

async function fetchMergePreviewCommitEvidence(config, token) {
  const payload = await fetchJson(`https://api.github.com/repos/${config.repository}/commits/${config.mergePreviewSha}`, token);
  const evidenceBody = {
    sha: requiredSha(payload.sha, 'merge preview commit SHA'),
    parentShas: Array.isArray(payload.parents) ? payload.parents.map((parent, index) => requiredSha(parent?.sha, `merge preview parent ${index}`)) : [],
    treeSha: requiredSha(payload.commit?.tree?.sha, 'merge preview tree SHA'),
    message: String(payload.commit?.message ?? ''),
    verified: payload.commit?.verification?.verified === true,
    verificationReason: String(payload.commit?.verification?.reason ?? ''),
    committerLogin: String(payload.committer?.login ?? '')
  };
  return Object.freeze({ ...evidenceBody, fingerprint: fingerprintText(JSON.stringify(evidenceBody)) });
}

async function fetchSourceWorkflowEvidence(config, token) {
  const observedJobs = [];
  for (let page = 1; ; page += 1) {
    const jobsPayload = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/runs/${config.sourceWorkflow.runId}/jobs?filter=latest&per_page=100&page=${page}`, token);
    const pageJobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];
    observedJobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
  }
  const byName = new Map();
  for (const job of observedJobs) {
    const name = String(job?.name ?? '').trim();
    if (!name) throw new Error('source workflow contains a job with no name');
    if (byName.has(name)) throw new Error(`source workflow contains duplicate latest jobs named ${name}`);
    byName.set(name, job);
  }
  const orderedJobs = config.sourceWorkflow.requiredJobs.map((expected) => {
    const job = byName.get(expected.name);
    if (!job) throw new Error(`configured required source workflow job is missing: ${expected.name}`);
    if (job.head_sha && requiredSha(job.head_sha, `source workflow job ${expected.name} head_sha`) !== config.materialHeadSha) {
      throw new Error(`source workflow job ${expected.name} is stale for configured material head`);
    }
    return Object.freeze({
      id: Number(job.id),
      name: String(job.name),
      scope: expected.scope,
      expectedConclusion: expected.expectedConclusion,
      status: String(job.status),
      conclusion: String(job.conclusion ?? ''),
      requiredSteps: expected.requiredSteps,
      steps: Array.isArray(job.steps) ? Object.freeze(job.steps.map((step) => Object.freeze({
        name: String(step.name ?? ''),
        status: String(step.status ?? ''),
        conclusion: step.conclusion == null ? null : String(step.conclusion)
      }))) : Object.freeze([])
    });
  });
  if (observedJobs.length !== orderedJobs.length) {
    const unexpected = observedJobs.map((job) => String(job.name)).filter((name) => !config.sourceWorkflow.requiredJobs.some((expected) => expected.name === name));
    throw new Error(`source workflow job inventory differs from configured CRITICAL matrix; unexpected jobs: ${unexpected.join(', ') || 'none'}`);
  }
  const gateBody = Object.freeze({ runId: config.sourceWorkflow.runId, jobs: Object.freeze(orderedJobs) });
  const gateEvidence = Object.freeze({ ...gateBody, fingerprint: fingerprintText(JSON.stringify(gateBody)) });

  const bindingMatches = orderedJobs.filter((job) => job.name === config.sourceWorkflow.bindingJobName);
  if (bindingMatches.length !== 1) throw new Error(`expected exactly one source workflow binding job named ${config.sourceWorkflow.bindingJobName}`);
  const bindingJob = bindingMatches[0];
  if (bindingJob.status !== 'completed' || bindingJob.conclusion !== 'success') throw new Error('source workflow binding job must be terminal green');
  const logText = await fetchText(`https://api.github.com/repos/${config.repository}/actions/jobs/${bindingJob.id}/logs`, token);
  const refPattern = new RegExp(`\\+${config.mergePreviewSha}:refs\\/remotes\\/pull\\/${config.pullRequestNumber}\\/merge\\b`, 'i');
  const refMappingObserved = refPattern.test(logText);
  const checkoutPattern = new RegExp(`HEAD is now at ${config.mergePreviewSha.slice(0, 7)}\\b`, 'i');
  const checkoutObserved = checkoutPattern.test(logText);
  if (!refMappingObserved || !checkoutObserved) throw new Error('source workflow log does not corroborate configured PR merge ref and checked-out merge preview');

  const bindingEvidence = Object.freeze({
    jobId: bindingJob.id,
    jobName: bindingJob.name,
    status: bindingJob.status,
    conclusion: bindingJob.conclusion,
    pullRequestNumber: config.pullRequestNumber,
    mergePreviewSha: config.mergePreviewSha,
    materialHeadSha: config.materialHeadSha,
    logFingerprint: fingerprintText(logText),
    refMappingObserved,
    checkoutObserved
  });
  return Object.freeze({ gateEvidence, bindingEvidence, logText });
}

function normalizePersistedTargetAuditState(raw, commentId) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error(`target audit state in comment ${commentId} must be an object`);
  if (raw.schemaVersion !== 2) throw new Error(`target audit state in comment ${commentId} has unsupported schemaVersion`);
  const targetAuditId = String(raw.targetAuditId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(targetAuditId)) throw new Error(`target audit state in comment ${commentId} has invalid targetAuditId`);
  const controlRepository = String(raw.controlRepository ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) throw new Error(`target audit state in comment ${commentId} has invalid controlRepository`);
  const publisher = raw.publisher;
  if (!publisher || typeof publisher !== 'object' || Array.isArray(publisher)) throw new Error(`target audit state in comment ${commentId} has invalid publisher`);
  const state = Object.freeze({
    schemaVersion: 2,
    controlRepository,
    targetAuditId,
    candidateSha: requiredSha(raw.candidateSha, `target audit state ${commentId} candidateSha`),
    mergePreviewSha: requiredSha(raw.mergePreviewSha, `target audit state ${commentId} mergePreviewSha`),
    mergeCommitSha: requiredSha(raw.mergeCommitSha, `target audit state ${commentId} mergeCommitSha`),
    auditWorkflowRunId: Number(raw.auditWorkflowRunId),
    sourceWorkflowRunId: Number(raw.sourceWorkflowRunId),
    decision: String(raw.decision ?? ''),
    requestFingerprint: requiredFingerprint(raw.requestFingerprint, `target audit state ${commentId} requestFingerprint`),
    runtimeSha: requiredSha(raw.runtimeSha, `target audit state ${commentId} runtimeSha`),
    publisher: Object.freeze({
      workflowName: String(publisher.workflowName ?? ''),
      workflowPath: String(publisher.workflowPath ?? ''),
      event: String(publisher.event ?? '')
    }),
    findings: Object.freeze(Array.isArray(raw.findings) ? raw.findings.map((finding) => Object.freeze({ ...finding })) : []),
    commentId
  });
  if (!Number.isInteger(state.auditWorkflowRunId) || state.auditWorkflowRunId < 1) throw new Error(`target audit state in comment ${commentId} has invalid auditWorkflowRunId`);
  if (!Number.isInteger(state.sourceWorkflowRunId) || state.sourceWorkflowRunId < 1) throw new Error(`target audit state in comment ${commentId} has invalid sourceWorkflowRunId`);
  if (!['approved', 'rejected'].includes(state.decision)) throw new Error(`target audit state in comment ${commentId} has invalid decision`);
  if (!Array.isArray(raw.findings)) throw new Error(`target audit state in comment ${commentId} findings must be an array`);
  return state;
}

async function assertControllerOwnedStateComment(comment, state, controlRepository, token) {
  const login = String(comment?.user?.login ?? '');
  const type = String(comment?.user?.type ?? '');
  if (login !== 'github-actions[bot]' || type !== 'Bot') throw new Error(`target audit state comment ${comment.id} is not controller-owned GitHub Actions state`);
  if (state.controlRepository !== controlRepository) throw new Error(`target audit state comment ${comment.id} belongs to another control repository`);
  if (state.publisher.workflowName !== CONTROL_WORKFLOW_NAME || state.publisher.workflowPath !== CONTROL_WORKFLOW_PATH || state.publisher.event !== CONTROL_WORKFLOW_EVENT) {
    throw new Error(`target audit state comment ${comment.id} declares an untrusted publisher`);
  }
  const expectedMarker = `<!-- delivery-v2-target-independent-audit:${state.targetAuditId}:${state.candidateSha}:${state.auditWorkflowRunId} -->`;
  if (!String(comment.body ?? '').includes(expectedMarker)) throw new Error(`target audit state comment ${comment.id} is missing its exact workflow-run marker`);

  const run = await fetchJson(`https://api.github.com/repos/${controlRepository}/actions/runs/${state.auditWorkflowRunId}`, token);
  if (String(run?.repository?.full_name ?? '') !== controlRepository) throw new Error(`target audit state comment ${comment.id} references a workflow run from another repository`);
  if (String(run?.name ?? '') !== CONTROL_WORKFLOW_NAME || String(run?.path ?? '') !== CONTROL_WORKFLOW_PATH || String(run?.event ?? '') !== CONTROL_WORKFLOW_EVENT) {
    throw new Error(`target audit state comment ${comment.id} references a non-controller workflow run`);
  }
  if (String(run?.status ?? '') !== 'completed') throw new Error(`target audit state comment ${comment.id} references a non-terminal controller workflow run`);
  const commentTime = Date.parse(String(comment?.created_at ?? ''));
  const runStart = Date.parse(String(run?.run_started_at ?? run?.created_at ?? ''));
  const runEnd = Date.parse(String(run?.updated_at ?? ''));
  if (![commentTime, runStart, runEnd].every(Number.isFinite) || commentTime < runStart - 60_000 || commentTime > runEnd + 60_000) {
    throw new Error(`target audit state comment ${comment.id} timestamp is not bound to the referenced controller workflow run`);
  }
}

async function fetchPersistedTargetAuditStates(controlRepository, issueNumber, token) {
  const states = [];
  for (let page = 1; ; page += 1) {
    const comments = await fetchJson(`https://api.github.com/repos/${controlRepository}/issues/${issueNumber}/comments?per_page=100&page=${page}`, token);
    if (!Array.isArray(comments)) throw new Error('target audit state comments response must be an array');
    for (const comment of comments) {
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
      const state = normalizePersistedTargetAuditState(parsed, Number(comment.id));
      await assertControllerOwnedStateComment(comment, state, controlRepository, token);
      states.push(state);
    }
    if (comments.length < 100) break;
  }
  const runIds = states.map((state) => state.auditWorkflowRunId);
  if (new Set(runIds).size !== runIds.length) throw new Error('durable target audit state contains duplicate audit workflow run ids');
  return Object.freeze(states);
}

function deriveTargetAuditProgress(config, states) {
  const relevant = states.filter((state) => state.targetAuditId === config.id);
  for (const state of relevant) {
    if (state.mergePreviewSha !== config.mergePreviewSha || state.mergeCommitSha !== config.mergeCommitSha || state.sourceWorkflowRunId !== config.sourceWorkflow.runId) {
      throw new Error(`durable target audit state for ${config.id} disagrees with configured historical identity`);
    }
  }
  const sameCandidate = relevant.filter((state) => state.candidateSha === config.materialHeadSha);
  if (sameCandidate.length > 0) throw new Error(`target candidate ${config.materialHeadSha} already has durable audit state; a new material SHA is required before re-audit`);
  const auditAttempt = relevant.length + 1;
  const priorFindings = [];
  const seen = new Set();
  for (const state of relevant) {
    for (const finding of state.findings) {
      const id = String(finding?.id ?? '').trim();
      if (!id) continue;
      const key = `${state.candidateSha}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      priorFindings.push({ id, candidateSha: state.candidateSha, status: state.decision === 'rejected' ? 'previous-rejection' : 'previous-audit' });
    }
  }
  return Object.freeze({ auditAttempt, implementationAttempt: auditAttempt, priorFindings: Object.freeze(priorFindings), priorStates: Object.freeze(relevant) });
}

function linuxHome(user) {
  const line = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
  const home = line.split(':')[5];
  if (!home) throw new Error(`could not resolve Linux home for ${user}`);
  return home;
}
async function loadTargetConfig(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('TARGET_AUDIT_ID is invalid');
  const url = new URL(`../config/delivery-v2-target-audits/${id}.json`, import.meta.url);
  const rawText = await readFile(url, 'utf8');
  const config = normalizeTargetAuditConfig(JSON.parse(rawText));
  if (config.id !== id) throw new Error('target audit config id does not match TARGET_AUDIT_ID');
  return Object.freeze({ config, rawText });
}
async function loadRuntimeEvidence(runtimeSha, targetConfigText) {
  const contractText = await readFile(new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url), 'utf8');
  const runnerText = await readFile(new URL(import.meta.url), 'utf8');
  const targetRuntimeText = await readFile(new URL('../src/v2/target-independent-audit-runtime.mjs', import.meta.url), 'utf8');
  const workflowText = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  return Object.freeze({
    contractText,
    evidence: Object.freeze({
      runtimeSha,
      contractFingerprint: fingerprintText(contractText),
      targetConfigFingerprint: fingerprintText(targetConfigText),
      runnerFingerprint: fingerprintText(runnerText),
      targetRuntimeFingerprint: fingerprintText(targetRuntimeText),
      workflowFingerprint: fingerprintText(workflowText)
    })
  });
}

async function writeReadonlyText(root, relativePath, content) {
  const safe = safeRepositoryPath(relativePath, 'bundle relative path');
  const destination = path.join(root, ...safe.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, 'utf8');
  await chmod(destination, 0o444);
}

async function prepareBundle({ request, config, contractText, changed, pullRequest, candidateWorkflow, baseWorkflow, classifierSource, sourceWorkflow, mergePreviewCommitEvidence, auditRuntimeEvidence, priorTargetAudits }) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-target-independent-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'TARGET_AUDIT_CONFIG.json': `${JSON.stringify(config, null, 2)}\n`,
    'AUDIT_RUNTIME_EVIDENCE.json': `${JSON.stringify(auditRuntimeEvidence, null, 2)}\n`,
    'SOURCE_WORKFLOW_GATES.json': `${JSON.stringify(sourceWorkflow.gateEvidence, null, 2)}\n`,
    'SOURCE_WORKFLOW_CORROBORATION.json': `${JSON.stringify(sourceWorkflow.bindingEvidence, null, 2)}\n`,
    'SOURCE_WORKFLOW_CORROBORATION.log': sourceWorkflow.logText,
    'MERGE_PREVIEW_COMMIT.json': `${JSON.stringify(mergePreviewCommitEvidence, null, 2)}\n`,
    'CHANGED_FILES.json': `${JSON.stringify(changed.manifest, null, 2)}\n`,
    'DIFF_COVERAGE.json': `${JSON.stringify(changed.evidence, null, 2)}\n`,
    'PRIOR_TARGET_AUDITS.json': `${JSON.stringify(priorTargetAudits, null, 2)}\n`,
    'MASTER_SPEC.md': contractText,
    'PULL_REQUEST.json': `${JSON.stringify({ number: pullRequest.number, title: pullRequest.title, body: pullRequest.body, state: pullRequest.state, merged: pullRequest.merged, base: pullRequest.base, head: pullRequest.head, merge_commit_sha: pullRequest.merge_commit_sha }, null, 2)}\n`,
    'SOURCE_WORKFLOW_BASE.yml': baseWorkflow.content,
    'SOURCE_WORKFLOW_CANDIDATE.yml': candidateWorkflow.content,
    'CLASSIFIER_SOURCE.mjs': classifierSource
  };
  for (const [name, content] of Object.entries(files)) await writeReadonlyText(root, name, content);
  for (const file of changed.files) {
    if (file.snapshots.base) await writeReadonlyText(root, `snapshots/base/${file.snapshots.base.path}`, file.snapshots.base.content);
    if (file.snapshots.head) await writeReadonlyText(root, `snapshots/head/${file.snapshots.head.path}`, file.snapshots.head.content);
  }
  return root;
}

function auditPrompt(request) {
  return `You are the independent semantic reviewer for a historical Delivery V2 CRITICAL target candidate.\n\n` +
    `Your entire allowed context is the sanitized Git repository bundle in the current working directory. Do not use or seek conversation history, legacy .audit handoffs, hidden implementer reasoning, network resources, or any source outside this bundle. Do not modify files or Git state.\n\n` +
    `Audit exactly ${request.candidate.repository} PR #${request.candidate.pullRequestNumber} candidate ${request.candidate.materialHeadSha}. The controller binds repository/PR/base/head/merge-preview/workflow identity in AUDIT_REQUEST.json. MERGE_PREVIEW_COMMIT.json is GitHub-owned commit evidence whose exact parents must be base then candidate head. SOURCE_WORKFLOW_CORROBORATION.log is candidate-workflow evidence under review and is corroboration only, never the merge-preview trust anchor.\n\n` +
    `SOURCE_WORKFLOW_GATES.json is the complete configured CRITICAL job/step matrix observed for the historical run. Every configured job is terminal with its expected conclusion and every required step was reached exactly once and passed. FAST/STANDARD validation are expected adaptive skips for this CRITICAL candidate.\n\n` +
    `The authoritative candidate code evidence is the complete exact-SHA file snapshots under snapshots/base and snapshots/head. CHANGED_FILES.json maps every changed path to immutable blob/content fingerprints; DIFF_COVERAGE.json binds the exhaustive inventory and snapshot set. Do not infer completeness from GitHub patch snippets. AUDIT_RUNTIME_EVIDENCE.json pins the audit runtime and contract/config/runtime fingerprints. PRIOR_TARGET_AUDITS.json contains only controller-owned durable prior target-audit state; the same material candidate is never re-audited.\n\n` +
    `IMPORTANT: the candidate changed its own source CI workflow. A green source CI run proves only that the configured run completed on the exact candidate; it is NOT a trust anchor for the workflow's correctness. Compare SOURCE_WORKFLOW_BASE.yml, SOURCE_WORKFLOW_CANDIDATE.yml, SOURCE_WORKFLOW_GATES.json, the full changed-file snapshots, and independently assess whether the candidate weakens required safety, risk classification, exact-head evidence, critical gates, or repository-specific promotion boundaries.\n\n` +
    `Review the whole candidate against MASTER_SPEC.md, with special attention to DV2-005/006/007/013 and fail-closed invariants. Return all cheap release-blocking findings in one pass. Finding IDs must be stable and start with DV2-. Use decision=approved only when there is no release-blocking finding; use decision=rejected when at least one blocksRelease=true finding exists. Evidence must identify a concrete path/contract mismatch, not private chain-of-thought.\n\n` +
    `Return only the requested JSON object with decision and findings.`;
}

async function main() {
  const targetAuditId = requiredEnv('TARGET_AUDIT_ID').toLowerCase();
  const githubToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const controlRepository = requiredEnv('GITHUB_REPOSITORY');
  const reviewerRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10);
  const runtimeSha = requiredSha(requiredEnv('AUDIT_RUNTIME_SHA'), 'AUDIT_RUNTIME_SHA');
  const checkedOutSha = requiredSha(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 'checked out runtime SHA');
  if (checkedOutSha !== runtimeSha) throw new Error(`checked out audit runtime ${checkedOutSha} does not match pinned AUDIT_RUNTIME_SHA ${runtimeSha}`);

  const auditorUser = process.env.DELIVERY_AUDITOR_USER || 'delivery-auditor';
  const implementerUser = process.env.DELIVERY_IMPLEMENTER_USER || 'delivery-implementer';
  const authMode = process.env.CODEX_AUTH_MODE || 'chatgpt';
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const resultPath = process.env.AUDIT_RESULT_PATH || path.join(process.env.RUNNER_TEMP || tmpdir(), 'delivery-v2-target-audit-result.json');
  const loadedConfig = await loadTargetConfig(targetAuditId);
  const config = loadedConfig.config;
  const runtime = await loadRuntimeEvidence(runtimeSha, loadedConfig.rawText);
  const persistedStates = await fetchPersistedTargetAuditStates(controlRepository, 27, githubToken);
  const progress = deriveTargetAuditProgress(config, persistedStates);

  const pullRequest = await fetchJson(`https://api.github.com/repos/${config.repository}/pulls/${config.pullRequestNumber}`, githubToken);
  const sourceWorkflowRun = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/runs/${config.sourceWorkflow.runId}`, githubToken);
  const sourceWorkflowDefinition = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/workflows/${config.sourceWorkflow.workflowId}`, githubToken);
  const sourceWorkflow = await fetchSourceWorkflowEvidence(config, githubToken);
  const mergePreviewCommitEvidence = await fetchMergePreviewCommitEvidence(config, githubToken);
  const changed = await fetchChangedFileEvidence(config.repository, config.pullRequestNumber, config.baseSha, config.materialHeadSha, githubToken);
  const candidateWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.materialHeadSha, githubToken);
  const baseWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.baseSha, githubToken);
  const classifierSource = (await fetchFileEvidenceAtRef(config.repository, config.classifierPath, config.materialHeadSha, githubToken)).content;

  const request = buildTargetCriticalAuditRequest({
    config,
    pullRequest,
    changedPaths: changed.paths,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowBindingEvidence: sourceWorkflow.bindingEvidence,
    sourceWorkflowGateEvidence: sourceWorkflow.gateEvidence,
    mergePreviewCommitEvidence,
    diffEvidence: changed.evidence,
    candidateWorkflowEvidence: candidateWorkflow,
    baseWorkflowEvidence: baseWorkflow,
    classifierSource,
    auditRuntimeEvidence: runtime.evidence,
    auditAttempt: progress.auditAttempt,
    implementationAttempt: progress.implementationAttempt,
    priorFindings: progress.priorFindings
  });

  let bundle;
  try {
    bundle = await prepareBundle({ request, config, contractText: runtime.contractText, changed, pullRequest, candidateWorkflow, baseWorkflow, classifierSource, sourceWorkflow, mergePreviewCommitEvidence, auditRuntimeEvidence: runtime.evidence, priorTargetAudits: progress.priorStates });
    const codexHome = process.env.CODEX_AUDITOR_HOME || path.join(linuxHome(auditorUser), '.codex-delivery', 'auditor');
    const executor = new CodexExecutor({ apiKey: process.env.OPENAI_API_KEY, authMode, model, implementerUser, auditorUser });
    const response = await executor.runFresh({
      workingDirectory: bundle,
      codexHome,
      prompt: auditPrompt(request),
      outputSchema: independentAuditModelOutputSchema(),
      role: 'auditor',
      githubToken: '',
      sandboxMode: 'read-only',
      networkAccessEnabled: false
    });
    const finalized = finalizeIndependentAuditResult({ request, modelResult: response.result, reviewerRunId });
    const evidence = {
      schemaVersion: 2,
      targetAuditId,
      target: {
        repository: config.repository,
        issueNumber: config.issueNumber,
        pullRequestNumber: config.pullRequestNumber,
        materialHeadSha: config.materialHeadSha,
        mergePreviewSha: config.mergePreviewSha,
        mergeCommitSha: config.mergeCommitSha
      },
      auditAttempt: progress.auditAttempt,
      sourceWorkflowRunId: config.sourceWorkflow.runId,
      sourceWorkflowCorroboration: sourceWorkflow.bindingEvidence,
      sourceWorkflowGateEvidence: sourceWorkflow.gateEvidence,
      mergePreviewCommitEvidence,
      diffEvidence: changed.evidence,
      auditWorkflowRunId: reviewerRunId,
      auditRuntime: runtime.evidence,
      request,
      result: finalized.result,
      outcome: finalized.outcome,
      modelUsage: response.usage ?? null,
      reviewerContextId: response.contextId
    };
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, targetAuditId, repository: config.repository, pullRequestNumber: config.pullRequestNumber, candidateSha: config.materialHeadSha, mergePreviewSha: config.mergePreviewSha, auditAttempt: progress.auditAttempt, decision: finalized.result.decision, releaseBlocked: finalized.outcome.releaseBlocked, requestFingerprint: request.requestFingerprint, runtimeSha, resultPath })}\n`);
  } finally {
    if (bundle) await rm(bundle, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
