#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CodexExecutor } from '../src/codex-executor.mjs';
import {
  DELIVERY_V2_SOURCE_WORKFLOW_PATH,
  assertTrustedCriticalAuditPilot,
  buildGithubNativeCriticalAuditRequest,
  finalizeIndependentAuditResult,
  independentAuditModelOutputSchema
} from '../src/v2/independent-audit-runtime.mjs';

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
    'User-Agent': 'delivery-v2-independent-auditor'
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

async function resolvePilotPullRequest({ repository, headBranch, headSha, token }) {
  const [owner] = repository.split('/');
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${headBranch}`, per_page: '100' });
  const pulls = await fetchJson(`https://api.github.com/repos/${repository}/pulls?${query}`, token);
  const matches = pulls.filter((pull) => String(pull.head?.sha).toLowerCase() === headSha.toLowerCase());
  if (matches.length !== 1) throw new Error(`expected exactly one open PR for ${headBranch}@${headSha}, found ${matches.length}`);
  return assertTrustedCriticalAuditPilot(matches[0], repository);
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

async function prepareBundle({ request, contractText, diffText, pullRequest }) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-independent-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'MASTER_SPEC.md': contractText,
    'CANDIDATE.diff': diffText,
    'PULL_REQUEST.json': `${JSON.stringify({ number: pullRequest.number, title: pullRequest.title, body: pullRequest.body, base: pullRequest.base, head: pullRequest.head }, null, 2)}\n`
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await writeFile(file, content, 'utf8');
    await chmod(file, 0o444);
  }
  return root;
}

function auditPrompt(request) {
  return `You are the independent semantic reviewer for a Delivery V2 CRITICAL candidate.\n\n` +
    `Your entire allowed context is the sanitized Git repository bundle in the current working directory. It contains AUDIT_REQUEST.json, MASTER_SPEC.md, CANDIDATE.diff, and PULL_REQUEST.json. Do not use or seek implementation conversation history, legacy V1 handoff artifacts, hidden implementer reasoning, or any source outside this bundle. Do not modify files or Git state.\n\n` +
    `Audit exactly candidate ${request.candidate.materialHeadSha}. Treat the GitHub identity/check evidence in AUDIT_REQUEST.json as authoritative. Review the candidate diff against the canonical Delivery V2 contract. Return all cheap blocking findings in one pass. Finding IDs must be stable and start with DV2-. Use decision=approved only when there is no release-blocking finding; use decision=rejected when at least one blocksRelease=true finding exists. Evidence must identify a concrete path/hunk/contract mismatch, not private chain-of-thought.\n\n` +
    `Judge the candidate that actually exists, including its reachable normal-path behavior. A release-blocking finding must identify concrete candidate code, configuration, workflow, or an uncovered active entrypoint that violates the contract now. Do not reject solely because a regression test could theoretically be bypassed by hypothetical future obfuscation, aliases, dynamic string construction, or code that is not present in this candidate. For DV2-014, apply the canonical requirement literally: Delivery V2 must be the only active normal-path entrypoint; historical evidence/catalog snapshots may remain traceability-only. Lexical marker checks are regression tripwires, not a universal JavaScript security boundary. A limitation in such a tripwire blocks release only when you can connect it to an actual active/reachable V1 dependency or to a concrete normal-path entrypoint that the structural gate fails to cover.\n\n` +
    `Return only the requested JSON object with decision and findings.`;
}

async function main() {
  const repository = requiredEnv('TARGET_REPOSITORY');
  const headBranch = requiredEnv('SOURCE_HEAD_BRANCH');
  const headSha = requiredEnv('SOURCE_HEAD_SHA').toLowerCase();
  const sourceWorkflowRunId = Number.parseInt(requiredEnv('SOURCE_WORKFLOW_RUN_ID'), 10);
  const issueNumber = Number.parseInt(process.env.TARGET_ISSUE || '27', 10);
  const githubToken = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const reviewerRunId = Number.parseInt(requiredEnv('GITHUB_RUN_ID'), 10);
  const auditorUser = process.env.DELIVERY_AUDITOR_USER || 'delivery-auditor';
  const implementerUser = process.env.DELIVERY_IMPLEMENTER_USER || 'delivery-implementer';
  const authMode = process.env.CODEX_AUTH_MODE || 'chatgpt';
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const resultPath = process.env.AUDIT_RESULT_PATH || path.join(process.env.RUNNER_TEMP || tmpdir(), 'delivery-v2-audit-result.json');

  const pullRequest = await resolvePilotPullRequest({ repository, headBranch, headSha, token: githubToken });
  const sourceWorkflowRun = await fetchJson(`https://api.github.com/repos/${repository}/actions/runs/${sourceWorkflowRunId}`, githubToken);
  if (String(sourceWorkflowRun.head_sha).toLowerCase() !== headSha) throw new Error('source workflow head does not match requested audit head');
  const sourceWorkflowDefinition = await fetchJson(`https://api.github.com/repos/${repository}/actions/workflows/${sourceWorkflowRun.workflow_id}`, githubToken);
  const sourceWorkflowEvidence = {
    candidate: await fetchFileEvidenceAtRef(repository, DELIVERY_V2_SOURCE_WORKFLOW_PATH, headSha, githubToken),
    trustedBase: await fetchFileEvidenceAtRef(repository, DELIVERY_V2_SOURCE_WORKFLOW_PATH, pullRequest.base.sha, githubToken)
  };
  const changedPaths = await fetchChangedPaths(repository, pullRequest.number, githubToken);
  const classifierSource = (await fetchFileEvidenceAtRef(repository, 'src/v2/risk-profile.mjs', headSha, githubToken)).content;
  const diffText = await fetchText(`https://api.github.com/repos/${repository}/pulls/${pullRequest.number}`, githubToken, 'application/vnd.github.v3.diff');
  const contractText = await readFile(new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url), 'utf8');
  const request = buildGithubNativeCriticalAuditRequest({
    repository,
    issueNumber,
    pullRequest,
    changedPaths,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowEvidence,
    classifierSource
  });

  let bundle;
  try {
    bundle = await prepareBundle({ request, contractText, diffText, pullRequest });
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
      repository,
      pullRequestNumber: pullRequest.number,
      sourceWorkflowRunId,
      auditWorkflowRunId: reviewerRunId,
      request,
      result: finalized.result,
      outcome: finalized.outcome,
      modelUsage: response.usage ?? null,
      reviewerContextId: response.contextId
    };
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, pullRequestNumber: pullRequest.number, candidateSha: headSha, decision: finalized.result.decision, requestFingerprint: request.requestFingerprint, resultPath })}\n`);
  } finally {
    if (bundle) await rm(bundle, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
