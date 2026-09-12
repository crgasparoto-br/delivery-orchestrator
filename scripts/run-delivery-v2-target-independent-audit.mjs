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

async function fetchChangedPaths(repository, pullRequestNumber, token) {
  const paths = [];
  for (let page = 1; ; page += 1) {
    const files = await fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, token);
    paths.push(...files.map((file) => file.filename));
    if (files.length < 100) break;
  }
  return paths;
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

async function fetchSourceWorkflowBinding(config, token) {
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
  const bindings = [...logText.matchAll(/\+([0-9a-f]{40}):refs\/remotes\/pull\/(\d+)\/merge\b/gi)]
    .map((match) => ({ mergePreviewSha: match[1].toLowerCase(), pullRequestNumber: Number.parseInt(match[2], 10) }));
  const unique = [...new Map(bindings.map((binding) => [`${binding.pullRequestNumber}:${binding.mergePreviewSha}`, binding])).values()];
  if (unique.length === 0) throw new Error('source workflow binding logs do not contain a pull/<number>/merge ref');
  const expected = unique.filter((binding) => binding.pullRequestNumber === config.pullRequestNumber && binding.mergePreviewSha === config.mergePreviewSha);
  const conflicting = unique.filter((binding) => binding.pullRequestNumber !== config.pullRequestNumber || binding.mergePreviewSha !== config.mergePreviewSha);
  if (expected.length !== 1 || conflicting.length > 0) {
    throw new Error(`source workflow binding logs are ambiguous for PR #${config.pullRequestNumber} merge preview ${config.mergePreviewSha}`);
  }

  return Object.freeze({
    jobId: Number(job.id),
    jobName: String(job.name),
    status: String(job.status),
    conclusion: String(job.conclusion),
    pullRequestNumber: config.pullRequestNumber,
    mergePreviewSha: config.mergePreviewSha,
    materialHeadSha: config.materialHeadSha,
    logFingerprint: fingerprintText(logText)
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

async function prepareBundle({ request, config, contractText, diffText, pullRequest, candidateWorkflow, baseWorkflow, classifierSource, sourceWorkflowBinding, auditRuntimeEvidence }) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-target-independent-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'TARGET_AUDIT_CONFIG.json': `${JSON.stringify(config, null, 2)}\n`,
    'AUDIT_RUNTIME_EVIDENCE.json': `${JSON.stringify(auditRuntimeEvidence, null, 2)}\n`,
    'SOURCE_WORKFLOW_BINDING.json': `${JSON.stringify(sourceWorkflowBinding, null, 2)}\n`,
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
    `Audit exactly ${request.candidate.repository} PR #${request.candidate.pullRequestNumber} candidate ${request.candidate.materialHeadSha}. The trusted controller has bound repository/PR/base/head/merge-preview/workflow-run identity in AUDIT_REQUEST.json, TARGET_AUDIT_CONFIG.json and SOURCE_WORKFLOW_BINDING.json. The audit runtime commit and contract/config/runtime fingerprints are in AUDIT_RUNTIME_EVIDENCE.json.\n\n` +
    `IMPORTANT: the candidate changed its own source CI workflow. A green source CI run proves only that the configured run completed successfully on the exact candidate; it is NOT a trust anchor for the workflow's correctness. Compare SOURCE_WORKFLOW_BASE.yml, SOURCE_WORKFLOW_CANDIDATE.yml and CANDIDATE.diff, and independently assess whether the candidate weakens required safety, risk classification, exact-head evidence, critical gates, or repository-specific promotion boundaries.\n\n` +
    `Review the whole candidate diff against MASTER_SPEC.md, with special attention to DV2-005/006/007/013 and fail-closed invariants. Return all cheap release-blocking findings in one pass. Finding IDs must be stable and start with DV2-. Use decision=approved only when there is no release-blocking finding; use decision=rejected when at least one blocksRelease=true finding exists. Evidence must identify a concrete path/hunk/contract mismatch, not private chain-of-thought.\n\n` +
    `Return only the requested JSON object with decision and findings.`;
}

async function main() {
  const targetAuditId = requiredEnv('TARGET_AUDIT_ID').toLowerCase();
  const githubToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
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

  const pullRequest = await fetchJson(`https://api.github.com/repos/${config.repository}/pulls/${config.pullRequestNumber}`, githubToken);
  const sourceWorkflowRun = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/runs/${config.sourceWorkflow.runId}`, githubToken);
  const sourceWorkflowDefinition = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/workflows/${config.sourceWorkflow.workflowId}`, githubToken);
  const sourceWorkflowBinding = await fetchSourceWorkflowBinding(config, githubToken);
  const changedPaths = await fetchChangedPaths(config.repository, config.pullRequestNumber, githubToken);
  const candidateWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.materialHeadSha, githubToken);
  const baseWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.baseSha, githubToken);
  const classifierSource = (await fetchFileEvidenceAtRef(config.repository, config.classifierPath, config.materialHeadSha, githubToken)).content;
  const diffText = await fetchText(`https://api.github.com/repos/${config.repository}/pulls/${config.pullRequestNumber}`, githubToken, 'application/vnd.github.v3.diff');

  const request = buildTargetCriticalAuditRequest({
    config,
    pullRequest,
    changedPaths,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowBindingEvidence: sourceWorkflowBinding,
    candidateWorkflowEvidence: candidateWorkflow,
    baseWorkflowEvidence: baseWorkflow,
    classifierSource,
    auditRuntimeEvidence: runtime.evidence
  });

  let bundle;
  try {
    bundle = await prepareBundle({
      request,
      config,
      contractText: runtime.contractText,
      diffText,
      pullRequest,
      candidateWorkflow,
      baseWorkflow,
      classifierSource,
      sourceWorkflowBinding,
      auditRuntimeEvidence: runtime.evidence
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
      sourceWorkflowRunId: config.sourceWorkflow.runId,
      sourceWorkflowBinding,
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
