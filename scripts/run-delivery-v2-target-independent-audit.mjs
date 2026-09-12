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

async function fetchChangedFileEvidence(repository, pullRequestNumber, token) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const pageFiles = await fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, token);
    if (!Array.isArray(pageFiles)) throw new Error('GitHub changed-file response must be an array');
    for (const file of pageFiles) {
      const filename = String(file?.filename ?? '').trim();
      const patch = typeof file?.patch === 'string' ? file.patch : '';
      if (!filename) throw new Error('changed-file evidence contains an empty filename');
      if (!patch) throw new Error(`changed-file evidence is incomplete: patch missing for ${filename}`);
      files.push(Object.freeze({
        filename,
        previousFilename: file.previous_filename ? String(file.previous_filename) : null,
        status: String(file.status ?? ''),
        blobSha: requiredSha(file.sha, `changed file ${filename} blob SHA`),
        additions: Number(file.additions ?? 0),
        deletions: Number(file.deletions ?? 0),
        changes: Number(file.changes ?? 0),
        patch
      }));
    }
    if (pageFiles.length < 100) break;
  }
  if (files.length === 0) throw new Error('target audit changed-file inventory must be non-empty');
  const paths = files.map((file) => file.filename);
  if (new Set(paths).size !== paths.length) throw new Error('target audit changed-file inventory contains duplicate filenames');

  const diffText = await fetchText(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`, token, 'application/vnd.github.v3.diff');
  if (!diffText.trim()) throw new Error('target audit candidate diff is empty');
  const diffPaths = [...diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2].trim());
  if (diffPaths.length !== files.length) {
    throw new Error(`candidate diff file count ${diffPaths.length} does not match changed-file inventory ${files.length}`);
  }
  const inventorySorted = [...paths].sort();
  const diffSorted = [...diffPaths].sort();
  if (inventorySorted.some((entry, index) => entry !== diffSorted[index])) {
    throw new Error('candidate diff paths do not exactly match changed-file inventory');
  }
  for (const file of files) {
    if (!diffText.includes(file.patch)) throw new Error(`candidate diff does not contain the full GitHub patch for ${file.filename}`);
  }

  const inventoryFingerprint = fingerprintText(JSON.stringify(files));
  const diffFingerprint = fingerprintText(diffText);
  return Object.freeze({
    files: Object.freeze(files),
    paths: Object.freeze(paths),
    diffText,
    evidence: Object.freeze({
      fileCount: files.length,
      paths: Object.freeze(paths),
      allPatchesPresent: true,
      inventoryFingerprint,
      diffFingerprint
    })
  });
}

async function fetchFileEvidenceAtRef(repository, filePath, ref, token) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ ref });
  const payload = await fetchJson(`https://api.github.com/repos/${repository}/contents/${encoded}?${query}`, token);
  if (payload.type !== 'file' || payload.encoding !== 'base64') throw new Error(`expected base64 file for ${filePath}@${ref}`);
  if (payload.path !== filePath) throw new Error(`GitHub content path mismatch for ${filePath}@${ref}`);
  return Object.freeze({
    ref: String(ref).toLowerCase(),
    path: filePath,
    blobSha: String(payload.sha ?? '').toLowerCase(),
    content: Buffer.from(payload.content, 'base64').toString('utf8')
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
  const fingerprint = fingerprintText(JSON.stringify(evidenceBody));
  return Object.freeze({ ...evidenceBody, fingerprint });
}

async function fetchSourceWorkflowCorroboration(config, token) {
  const jobsPayload = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/runs/${config.sourceWorkflow.runId}/jobs?filter=latest&per_page=100`, token);
  const jobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];
  const matches = jobs.filter((job) => job.name === config.sourceWorkflow.bindingJobName);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one source workflow binding job named ${config.sourceWorkflow.bindingJobName}; found ${matches.length}`);
  }
  const job = matches[0];
  if (job.status !== 'completed' || job.conclusion !== 'success') throw new Error('source workflow binding job must be terminal green');
  if (job.head_sha && requiredSha(job.head_sha, 'source workflow binding job head_sha') !== config.materialHeadSha) {
    throw new Error('source workflow binding job is stale for configured material head');
  }

  const logText = await fetchText(`https://api.github.com/repos/${config.repository}/actions/jobs/${job.id}/logs`, token);
  const refPattern = new RegExp(`\\+${config.mergePreviewSha}:refs\\/remotes\\/pull\\/${config.pullRequestNumber}\\/merge\\b`, 'i');
  const refMappingObserved = refPattern.test(logText);
  const checkoutPattern = new RegExp(`HEAD is now at ${config.mergePreviewSha.slice(0, 7)}\\b`, 'i');
  const checkoutObserved = checkoutPattern.test(logText);
  if (!refMappingObserved || !checkoutObserved) {
    throw new Error('source workflow log does not corroborate the configured PR merge ref and checked-out merge preview');
  }

  return Object.freeze({
    evidence: Object.freeze({
      jobId: Number(job.id),
      jobName: String(job.name),
      status: String(job.status),
      conclusion: String(job.conclusion),
      pullRequestNumber: config.pullRequestNumber,
      mergePreviewSha: config.mergePreviewSha,
      materialHeadSha: config.materialHeadSha,
      logFingerprint: fingerprintText(logText),
      refMappingObserved,
      checkoutObserved
    }),
    logText
  });
}

function normalizePersistedTargetAuditState(raw, commentId) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error(`target audit state in comment ${commentId} must be an object`);
  if (raw.schemaVersion !== 1) throw new Error(`target audit state in comment ${commentId} has unsupported schemaVersion`);
  const targetAuditId = String(raw.targetAuditId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(targetAuditId)) throw new Error(`target audit state in comment ${commentId} has invalid targetAuditId`);
  const candidateSha = requiredSha(raw.candidateSha, `target audit state ${commentId} candidateSha`);
  const requestFingerprint = requiredFingerprint(raw.requestFingerprint, `target audit state ${commentId} requestFingerprint`);
  const runtimeSha = requiredSha(raw.runtimeSha, `target audit state ${commentId} runtimeSha`);
  if (!Number.isInteger(raw.auditWorkflowRunId) || raw.auditWorkflowRunId < 1) throw new Error(`target audit state in comment ${commentId} has invalid auditWorkflowRunId`);
  if (!Number.isInteger(raw.sourceWorkflowRunId) || raw.sourceWorkflowRunId < 1) throw new Error(`target audit state in comment ${commentId} has invalid sourceWorkflowRunId`);
  if (!['approved', 'rejected'].includes(raw.decision)) throw new Error(`target audit state in comment ${commentId} has invalid decision`);
  if (!Array.isArray(raw.findings)) throw new Error(`target audit state in comment ${commentId} findings must be an array`);
  return Object.freeze({
    schemaVersion: 1,
    targetAuditId,
    candidateSha,
    auditWorkflowRunId: raw.auditWorkflowRunId,
    sourceWorkflowRunId: raw.sourceWorkflowRunId,
    decision: raw.decision,
    requestFingerprint,
    runtimeSha,
    findings: Object.freeze(raw.findings.map((finding) => Object.freeze({ ...finding }))),
    commentId
  });
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
      states.push(normalizePersistedTargetAuditState(parsed, Number(comment.id)));
    }
    if (comments.length < 100) break;
  }
  const runIds = states.map((state) => state.auditWorkflowRunId);
  if (new Set(runIds).size !== runIds.length) throw new Error('durable target audit state contains duplicate audit workflow run ids');
  return Object.freeze(states);
}

function deriveTargetAuditProgress(config, states) {
  const relevant = states.filter((state) => state.targetAuditId === config.id);
  const sameCandidate = relevant.filter((state) => state.candidateSha === config.materialHeadSha);
  if (sameCandidate.length > 0) {
    throw new Error(`target candidate ${config.materialHeadSha} already has durable audit state; a new material SHA is required before re-audit`);
  }
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
      priorFindings.push({
        id,
        candidateSha: state.candidateSha,
        status: state.decision === 'rejected' ? 'previous-rejection' : 'previous-audit'
      });
    }
  }
  return Object.freeze({
    auditAttempt,
    implementationAttempt: auditAttempt,
    priorFindings: Object.freeze(priorFindings),
    priorStates: Object.freeze(relevant)
  });
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
  const parsed = JSON.parse(rawText);
  const config = normalizeTargetAuditConfig(parsed);
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

async function prepareBundle({
  request,
  config,
  contractText,
  diffText,
  changedFiles,
  diffEvidence,
  pullRequest,
  candidateWorkflow,
  baseWorkflow,
  classifierSource,
  sourceWorkflowCorroboration,
  sourceWorkflowLogText,
  mergePreviewCommitEvidence,
  auditRuntimeEvidence,
  priorTargetAudits
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-target-independent-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'TARGET_AUDIT_CONFIG.json': `${JSON.stringify(config, null, 2)}\n`,
    'AUDIT_RUNTIME_EVIDENCE.json': `${JSON.stringify(auditRuntimeEvidence, null, 2)}\n`,
    'SOURCE_WORKFLOW_CORROBORATION.json': `${JSON.stringify(sourceWorkflowCorroboration, null, 2)}\n`,
    'SOURCE_WORKFLOW_CORROBORATION.log': sourceWorkflowLogText,
    'MERGE_PREVIEW_COMMIT.json': `${JSON.stringify(mergePreviewCommitEvidence, null, 2)}\n`,
    'CHANGED_FILES.json': `${JSON.stringify(changedFiles, null, 2)}\n`,
    'DIFF_COVERAGE.json': `${JSON.stringify(diffEvidence, null, 2)}\n`,
    'PRIOR_TARGET_AUDITS.json': `${JSON.stringify(priorTargetAudits, null, 2)}\n`,
    'MASTER_SPEC.md': contractText,
    'CANDIDATE.diff': diffText,
    'PULL_REQUEST.json': `${JSON.stringify({
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      state: pullRequest.state,
      merged: pullRequest.merged,
      base: pullRequest.base,
      head: pullRequest.head,
      merge_commit_sha: pullRequest.merge_commit_sha
    }, null, 2)}\n`,
    'SOURCE_WORKFLOW_BASE.yml': baseWorkflow.content,
    'SOURCE_WORKFLOW_CANDIDATE.yml': candidateWorkflow.content,
    'CLASSIFIER_SOURCE.mjs': classifierSource
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await writeFile(file, content, 'utf8');
    await chmod(file, 0o444);
  }
  return root;
}

function auditPrompt(request) {
  return `You are the independent semantic reviewer for a historical Delivery V2 CRITICAL target candidate.\n\n` +
    `Your entire allowed context is the sanitized Git repository bundle in the current working directory. Do not use or seek conversation history, legacy .audit handoffs, hidden implementer reasoning, network resources, or any source outside this bundle. Do not modify files or Git state.\n\n` +
    `Audit exactly ${request.candidate.repository} PR #${request.candidate.pullRequestNumber} candidate ${request.candidate.materialHeadSha}. The controller binds repository/PR/base/head/merge-preview/workflow identity in AUDIT_REQUEST.json. MERGE_PREVIEW_COMMIT.json is GitHub-owned commit evidence whose exact parents must be base then candidate head. SOURCE_WORKFLOW_CORROBORATION.log is candidate-workflow evidence under review and is corroboration only, never the merge-preview trust anchor.\n\n` +
    `DIFF_COVERAGE.json and CHANGED_FILES.json attest that every GitHub changed-file entry has a patch and that the aggregate CANDIDATE.diff covers exactly that inventory. AUDIT_RUNTIME_EVIDENCE.json pins the audit runtime and contract/config/runtime fingerprints. PRIOR_TARGET_AUDITS.json contains any durable prior target-audit state; the same material candidate is never re-audited.\n\n` +
    `IMPORTANT: the candidate changed its own source CI workflow. A green source CI run proves only that the configured run completed successfully on the exact candidate; it is NOT a trust anchor for the workflow's correctness. Compare SOURCE_WORKFLOW_BASE.yml, SOURCE_WORKFLOW_CANDIDATE.yml, SOURCE_WORKFLOW_CORROBORATION.log and CANDIDATE.diff, and independently assess whether the candidate weakens required safety, risk classification, exact-head evidence, critical gates, or repository-specific promotion boundaries.\n\n` +
    `Review the whole candidate diff against MASTER_SPEC.md, with special attention to DV2-005/006/007/013 and fail-closed invariants. Return all cheap release-blocking findings in one pass. Finding IDs must be stable and start with DV2-. Use decision=approved only when there is no release-blocking finding; use decision=rejected when at least one blocksRelease=true finding exists. Evidence must identify a concrete path/hunk/contract mismatch, not private chain-of-thought.\n\n` +
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
  const sourceWorkflowCorroboration = await fetchSourceWorkflowCorroboration(config, githubToken);
  const mergePreviewCommitEvidence = await fetchMergePreviewCommitEvidence(config, githubToken);
  const changed = await fetchChangedFileEvidence(config.repository, config.pullRequestNumber, githubToken);
  const candidateWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.materialHeadSha, githubToken);
  const baseWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.baseSha, githubToken);
  const classifierSource = (await fetchFileEvidenceAtRef(config.repository, config.classifierPath, config.materialHeadSha, githubToken)).content;

  const request = buildTargetCriticalAuditRequest({
    config,
    pullRequest,
    changedPaths: changed.paths,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowBindingEvidence: sourceWorkflowCorroboration.evidence,
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
    bundle = await prepareBundle({
      request,
      config,
      contractText: runtime.contractText,
      diffText: changed.diffText,
      changedFiles: changed.files,
      diffEvidence: changed.evidence,
      pullRequest,
      candidateWorkflow,
      baseWorkflow,
      classifierSource,
      sourceWorkflowCorroboration: sourceWorkflowCorroboration.evidence,
      sourceWorkflowLogText: sourceWorkflowCorroboration.logText,
      mergePreviewCommitEvidence,
      auditRuntimeEvidence: runtime.evidence,
      priorTargetAudits: progress.priorStates
    });
    const codexHome = process.env.CODEX_AUDITOR_HOME || path.join(linuxHome(auditorUser), '.codex-delivery', 'auditor');
    const executor = new CodexExecutor({
      apiKey: process.env.OPENAI_API_KEY,
      authMode,
      model,
      implementerUser,
      auditorUser
    });
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
      schemaVersion: 1,
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
      sourceWorkflowCorroboration: sourceWorkflowCorroboration.evidence,
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
    process.stdout.write(`${JSON.stringify({
      ok: true,
      targetAuditId,
      repository: config.repository,
      pullRequestNumber: config.pullRequestNumber,
      candidateSha: config.materialHeadSha,
      mergePreviewSha: config.mergePreviewSha,
      auditAttempt: progress.auditAttempt,
      decision: finalized.result.decision,
      releaseBlocked: finalized.outcome.releaseBlocked,
      requestFingerprint: request.requestFingerprint,
      runtimeSha,
      resultPath
    })}\n`);
  } finally {
    if (bundle) await rm(bundle, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
