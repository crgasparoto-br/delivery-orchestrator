#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
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

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

async function fetchText(url, token, accept) {
  const response = await fetch(url, { headers: apiHeaders(token, accept) });
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

function linuxHome(user) {
  const line = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
  const home = line.split(':')[5];
  if (!home) throw new Error(`could not resolve Linux home for ${user}`);
  return home;
}

async function loadTargetConfig(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('TARGET_AUDIT_ID is invalid');
  const url = new URL(`../config/delivery-v2-target-audits/${id}.json`, import.meta.url);
  const parsed = JSON.parse(await readFile(url, 'utf8'));
  const config = normalizeTargetAuditConfig(parsed);
  if (config.id !== id) throw new Error('target audit config id does not match TARGET_AUDIT_ID');
  return config;
}

async function prepareBundle({ request, config, contractText, diffText, pullRequest, candidateWorkflow, baseWorkflow, classifierSource }) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-target-independent-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'TARGET_AUDIT_CONFIG.json': `${JSON.stringify(config, null, 2)}\n`,
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
    `Audit exactly ${request.candidate.repository} PR #${request.candidate.pullRequestNumber} candidate ${request.candidate.materialHeadSha}. The trusted controller has bound repository/PR/base/head/workflow-run identity in AUDIT_REQUEST.json and TARGET_AUDIT_CONFIG.json.\n\n` +
    `IMPORTANT: the candidate changed its own source CI workflow. A green source CI run proves only that the configured run completed successfully on the exact candidate; it is NOT a trust anchor for the workflow's correctness. Compare SOURCE_WORKFLOW_BASE.yml, SOURCE_WORKFLOW_CANDIDATE.yml and CANDIDATE.diff, and independently assess whether the candidate weakens required safety, risk classification, exact-head evidence, critical gates, or repository-specific promotion boundaries.\n\n` +
    `Review the whole candidate diff against MASTER_SPEC.md, with special attention to DV2-005/006/007/013 and fail-closed invariants. Return all cheap release-blocking findings in one pass. Finding IDs must be stable and start with DV2-. Use decision=approved only when there is no release-blocking finding; use decision=rejected when at least one blocksRelease=true finding exists. Evidence must identify a concrete path/hunk/contract mismatch, not private chain-of-thought.\n\n` +
    `Return only the requested JSON object with decision and findings.`;
}

async function main() {
  const targetAuditId = requiredEnv('TARGET_AUDIT_ID').toLowerCase();
  const githubToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const reviewerRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10);
  const auditorUser = process.env.DELIVERY_AUDITOR_USER || 'delivery-auditor';
  const implementerUser = process.env.DELIVERY_IMPLEMENTER_USER || 'delivery-implementer';
  const authMode = process.env.CODEX_AUTH_MODE || 'chatgpt';
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const resultPath = process.env.AUDIT_RESULT_PATH || path.join(process.env.RUNNER_TEMP || tmpdir(), 'delivery-v2-target-audit-result.json');
  const config = await loadTargetConfig(targetAuditId);

  const pullRequest = await fetchJson(`https://api.github.com/repos/${config.repository}/pulls/${config.pullRequestNumber}`, githubToken);
  const sourceWorkflowRun = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/runs/${config.sourceWorkflow.runId}`, githubToken);
  const sourceWorkflowDefinition = await fetchJson(`https://api.github.com/repos/${config.repository}/actions/workflows/${config.sourceWorkflow.workflowId}`, githubToken);
  const changedPaths = await fetchChangedPaths(config.repository, config.pullRequestNumber, githubToken);
  const candidateWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.materialHeadSha, githubToken);
  const baseWorkflow = await fetchFileEvidenceAtRef(config.repository, config.sourceWorkflow.path, config.baseSha, githubToken);
  const classifierSource = (await fetchFileEvidenceAtRef(config.repository, config.classifierPath, config.materialHeadSha, githubToken)).content;
  const diffText = await fetchText(`https://api.github.com/repos/${config.repository}/pulls/${config.pullRequestNumber}`, githubToken, 'application/vnd.github.v3.diff');
  const contractText = await readFile(new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url), 'utf8');

  const request = buildTargetCriticalAuditRequest({
    config,
    pullRequest,
    changedPaths,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    candidateWorkflowEvidence: candidateWorkflow,
    baseWorkflowEvidence: baseWorkflow,
    classifierSource
  });

  let bundle;
  try {
    bundle = await prepareBundle({ request, config, contractText, diffText, pullRequest, candidateWorkflow, baseWorkflow, classifierSource });
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
        mergeCommitSha: config.mergeCommitSha
      },
      sourceWorkflowRunId: config.sourceWorkflow.runId,
      auditWorkflowRunId: reviewerRunId,
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
      decision: finalized.result.decision,
      requestFingerprint: request.requestFingerprint,
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
