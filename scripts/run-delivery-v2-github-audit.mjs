#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodexExecutor } from '../src/codex-executor.mjs';
import {
  buildGithubNativeAuditRequest,
  finalizeGithubNativeAuditResult,
  githubNativeAuditOutputSchema
} from '../src/v2/github-native-audit-runtime.mjs';
import {
  assertPullRequestSnapshotStable,
  fetchAuditClassifier,
  fetchBoundedAuditContext,
  fetchFileEvidenceAtRef,
  fetchImmutableCompareEvidence
} from '../src/v2/github-audit-evidence.mjs';

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function positiveInteger(name, fallback = null) {
  const raw = process.env[name] ?? fallback;
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function apiHeaders(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'delivery-v2-github-native-auditor' };
}
async function fetchJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.json();
}
function linuxHome(user) {
  const line = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
  const home = line.split(':')[5];
  if (!home) throw new Error(`could not resolve Linux home for ${user}`);
  return home;
}
async function prepareBundle({ request, contractText, diffText, materialContext, issue, pullRequest }) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-github-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'DELIVERY_CONTRACT.md': contractText,
    'ISSUE.json': `${JSON.stringify({ number: issue.number, title: issue.title, body: issue.body, labels: issue.labels?.map((item) => item.name) ?? [] }, null, 2)}\n`,
    'PULL_REQUEST.json': `${JSON.stringify({ number: pullRequest.number, title: pullRequest.title, body: pullRequest.body, base: pullRequest.base, head: pullRequest.head }, null, 2)}\n`,
    'CANDIDATE.diff': diffText,
    'MATERIAL_CONTEXT.json': `${JSON.stringify(materialContext, null, 2)}\n`
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await writeFile(file, content, 'utf8');
    await chmod(file, 0o444);
  }
  return root;
}
function auditPrompt(request) {
  return [
    'You are the independent semantic reviewer for a Delivery V2 candidate.',
    '',
    'Your entire allowed context is the sanitized bundle in the current working directory: AUDIT_REQUEST.json, DELIVERY_CONTRACT.md, ISSUE.json, PULL_REQUEST.json, CANDIDATE.diff and MATERIAL_CONTEXT.json. Do not seek implementation conversation history, hidden implementer reasoning, legacy V1 handoff material, generated workflow locks or unrelated repository inventory. Do not modify files or Git state.',
    '',
    'MATERIAL_CONTEXT.json is deterministic exact-SHA expansion prepared by the control plane. It contains bounded full contents for prioritized changed source files plus one-hop direct relative dependencies when resolvable. Respect its limits and omitted manifest. If a release-blocking conclusion genuinely depends on a changed file omitted by that manifest, report a concrete audit-context-insufficient finding instead of guessing or browsing outside the bundle.',
    '',
    `Audit exactly candidate ${request.candidate.materialHeadSha}. Treat AUDIT_REQUEST.json identity/check evidence as authoritative. First verify the issue acceptance contract against the candidate diff and full material context, then apply Delivery V2 invariants. Return all cheap blocking findings in one pass. Findings must identify concrete candidate behavior/configuration and discriminating evidence. Do not reject hypothetical future code that is absent from this candidate.`,
    '',
    'Use decision=approved only when no release-blocking finding exists. Return only the requested JSON object.'
  ].join('\n');
}

function priorFindingsFromEnv() {
  const raw = String(process.env.PRIOR_FINDINGS_JSON ?? '[]').trim() || '[]';
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('PRIOR_FINDINGS_JSON must be a JSON array');
  return parsed.map((finding, index) => {
    if (!finding || Array.isArray(finding) || typeof finding !== 'object') throw new Error(`PRIOR_FINDINGS_JSON[${index}] must be an object`);
    const id = String(finding.id ?? '').trim();
    const candidateSha = String(finding.candidateSha ?? '').trim().toLowerCase();
    const status = String(finding.status ?? '').trim();
    if (!id || !/^[0-9a-f]{40}$/.test(candidateSha) || !status) throw new Error(`PRIOR_FINDINGS_JSON[${index}] is incomplete`);
    return Object.freeze({ id, candidateSha, status });
  });
}

export async function main() {
  const repository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger('TARGET_ISSUE');
  const pullRequestNumber = positiveInteger('TARGET_PR');
  const sourceWorkflowRunId = positiveInteger('SOURCE_WORKFLOW_RUN_ID');
  const workflowName = requiredEnv('SOURCE_WORKFLOW_NAME');
  const workflowPath = requiredEnv('SOURCE_WORKFLOW_PATH');
  const riskProfile = requiredEnv('AUDIT_RISK_PROFILE').toLowerCase();
  const implementerProvider = requiredEnv('IMPLEMENTER_PROVIDER').toLowerCase();
  const implementerWorkerIdentity = requiredEnv('IMPLEMENTER_WORKER_IDENTITY');
  const implementerRunId = positiveInteger('IMPLEMENTER_RUN_ID');
  const priorFindings = priorFindingsFromEnv();
  const token = requiredEnv('DELIVERY_GITHUB_READ_TOKEN');
  const reviewerRunId = positiveInteger('GITHUB_RUN_ID');
  const orchestratorRepository = requiredEnv('GITHUB_REPOSITORY');
  const auditorUser = process.env.DELIVERY_AUDITOR_USER || 'delivery-auditor';
  const implementerUser = process.env.DELIVERY_IMPLEMENTER_USER || 'delivery-implementer';
  const authMode = process.env.CODEX_AUTH_MODE || 'chatgpt';
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const resultPath = process.env.AUDIT_RESULT_PATH || path.join(process.env.RUNNER_TEMP || tmpdir(), 'delivery-v2-github-audit-result.json');

  const [pullRequest, issue, sourceWorkflowRun] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`, token),
    fetchJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, token),
    fetchJson(`https://api.github.com/repos/${repository}/actions/runs/${sourceWorkflowRunId}`, token)
  ]);
  const candidateSha = String(pullRequest.head?.sha ?? '').toLowerCase();
  const baseSha = String(pullRequest.base?.sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(candidateSha) || !/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('target PR lacks exact base/head SHA identity');

  const sourceWorkflowDefinition = await fetchJson(`https://api.github.com/repos/${repository}/actions/workflows/${sourceWorkflowRun.workflow_id}`, token);
  const [candidateWorkflow, baseWorkflow, classifier, compareEvidence] = await Promise.all([
    fetchFileEvidenceAtRef(repository, workflowPath, candidateSha, token),
    fetchFileEvidenceAtRef(repository, workflowPath, baseSha, token),
    fetchAuditClassifier(repository, candidateSha, token, { orchestratorRepository }),
    fetchImmutableCompareEvidence(repository, baseSha, candidateSha, token)
  ]);
  const materialContext = await fetchBoundedAuditContext(repository, candidateSha, compareEvidence.changedPaths, token);
  const stablePullRequest = await fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`, token);
  assertPullRequestSnapshotStable(pullRequest, stablePullRequest);

  const request = buildGithubNativeAuditRequest({
    repository,
    issueNumber,
    pullRequest: stablePullRequest,
    changedPaths: compareEvidence.changedPaths,
    riskProfile,
    riskReasons: [`controller-effective-risk:${riskProfile}`],
    classifier,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowEvidence: { candidate: candidateWorkflow, trustedBase: baseWorkflow },
    workflowName,
    workflowPath,
    implementationAttempt: positiveInteger('IMPLEMENTATION_ATTEMPT', '1'),
    implementer: { provider: implementerProvider, workerIdentity: implementerWorkerIdentity, runId: implementerRunId },
    priorFindings
  });

  const contractUrl = repository === orchestratorRepository
    ? new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url)
    : new URL('../docs/delivery-v2/AUDIT_CONTRACT.md', import.meta.url);
  const contractText = await readFile(contractUrl, 'utf8');

  let bundle;
  try {
    bundle = await prepareBundle({ request, contractText, diffText: compareEvidence.diffText, materialContext, issue, pullRequest: stablePullRequest });
    const codexHome = process.env.CODEX_AUDITOR_HOME || path.join(linuxHome(auditorUser), '.codex-delivery', 'auditor');
    const executor = new CodexExecutor({ apiKey: process.env.OPENAI_API_KEY, authMode, model, implementerUser, auditorUser });
    const response = await executor.runFresh({
      workingDirectory: bundle,
      codexHome,
      prompt: auditPrompt(request),
      outputSchema: githubNativeAuditOutputSchema(),
      role: 'auditor',
      githubToken: '',
      sandboxMode: 'read-only',
      networkAccessEnabled: false
    });
    const finalized = finalizeGithubNativeAuditResult({ request, modelResult: response.result, reviewerRunId });
    const payload = {
      schemaVersion: 1,
      repository,
      issueNumber,
      pullRequestNumber,
      sourceWorkflowRunId,
      auditWorkflowRunId: reviewerRunId,
      request,
      result: finalized.result,
      outcome: finalized.outcome,
      modelUsage: response.usage ?? null,
      reviewerContextId: response.contextId,
      materialContext: {
        strategy: materialContext.strategy,
        limits: materialContext.limits,
        totalBytes: materialContext.totalBytes,
        fileCount: materialContext.files.length,
        omittedCount: materialContext.omitted.length
      }
    };
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, pullRequestNumber, candidateSha: request.candidate.materialHeadSha, decision: finalized.result.decision, resultPath })}\n`);
  } finally {
    if (bundle) await rm(bundle, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
