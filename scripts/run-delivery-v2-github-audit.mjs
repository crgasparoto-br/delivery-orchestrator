#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodexExecutor } from '../src/codex-executor.mjs';
import { boundAuditDiff } from '../src/v2/bounded-audit-diff.mjs';
import {
  auditContextInsufficientFinding,
  evaluateAuditBundleBudget
} from '../src/v2/audit-bundle-budget.mjs';
import {
  buildGithubNativeAuditRequest,
  finalizeGithubNativeAuditResult,
  githubNativeAuditOutputSchema
} from '../src/v2/github-native-audit-runtime.mjs';
import {
  assertPullRequestSnapshotStable,
  auditContextLimitsForRisk,
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

function materialBundleFiles({ request, contractText, diffEvidence, materialContext }) {
  return Object.freeze({
    'AUDIT_REQUEST.json': `${JSON.stringify(request, null, 2)}\n`,
    'DELIVERY_CONTRACT.md': contractText,
    'CANDIDATE.diff': diffEvidence.text,
    'DIFF_MANIFEST.json': `${JSON.stringify(diffEvidence.manifest, null, 2)}\n`,
    'MATERIAL_CONTEXT.json': `${JSON.stringify(materialContext, null, 2)}\n`
  });
}
async function prepareBundle({ files, issue, pullRequest }) {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-v2-github-audit-'));
  await chmod(root, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const bundleFiles = {
    ...files,
    'ISSUE.json': JSON.stringify(issue),
    'PULL_REQUEST.json': JSON.stringify(pullRequest)
  };
  for (const [name, content] of Object.entries(bundleFiles)) {
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
    'Your entire allowed context is the sanitized bundle in the current working directory: AUDIT_REQUEST.json, DELIVERY_CONTRACT.md, ISSUE.json, PULL_REQUEST.json, CANDIDATE.diff, DIFF_MANIFEST.json and MATERIAL_CONTEXT.json. ISSUE.json and PULL_REQUEST.json are deterministic bounded projections, not raw GitHub API objects. Do not seek implementation conversation history, hidden implementer reasoning, retired delivery snapshots, generated workflow locks or unrelated repository inventory. Do not modify files or Git state.',
    '',
    'CANDIDATE.diff is a deterministic bounded subset of the exact base-to-candidate unified diff. DIFF_MANIFEST.json binds the full diff by SHA-256 and byte count, derives each represented path from its own Git diff identity, and uses the same shared semantic classifier as MATERIAL_CONTEXT.json. MATERIAL_CONTEXT.json may represent a large exact-SHA text file as ordered chunks. For a chunked file, require one common path/blobSha/fileSha256, contiguous byte coverage from 0 through fileBytes, chunkIndex 0..chunkCount-1 with no gaps, and use the ordered concatenation as the complete file evidence. A fully covered chunked file is represented material, not omitted context. Before any supplemental file reads or model invocation, the runtime requires exact diff-path alignment and complete representation of every material required semantic class present in the candidate: executable source, tests, contract/config, evidence, canonical docs and active worker prompts. File-count, aggregate-byte, malformed-path and reservation failures all use the same deterministic fail-closed preflight and produce a zero-provider-call context-insufficient rejection. Only a ready bounded diff may seed supplemental material context; represented paths are never charged twice. Generated locks never displace semantic material and every changed path remains represented, chunked with complete coverage, or explicitly omitted with a reason. Respect both manifests and their fixed limits. If a release-blocking conclusion genuinely depends on still-omitted context, report a concrete audit-context-insufficient finding instead of guessing or browsing outside the bundle.',
    '',
    `Audit exactly candidate ${request.candidate.materialHeadSha}. Treat AUDIT_REQUEST.json identity/check evidence as authoritative. First verify the issue acceptance contract against the bounded candidate diff and supplemental material context available in the bundle, then apply Delivery V2 invariants. Return all cheap blocking findings in one pass. Findings must identify concrete candidate behavior/configuration and discriminating evidence. Do not reject hypothetical future code that is absent from this candidate.`,
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

function boundedDiffPreflightReasons(manifest) {
  const reasons = new Set(Array.isArray(manifest?.preflightReasons) ? manifest.preflightReasons.map((value) => String(value).trim()).filter(Boolean) : []);
  if (manifest?.alignmentExact !== true) reasons.add('path-alignment-unproven');
  if (manifest?.reservationCoverageComplete !== true) reasons.add('semantic-reservation-incomplete');
  for (const [category, reservation] of Object.entries(manifest?.categoryReservations ?? {})) {
    if (reservation?.required === true && reservation?.included !== true) reasons.add(`required-reservation-not-included:${category}`);
  }
  if (manifest?.contextReady !== true) reasons.add('context-readiness-unproven');
  return Object.freeze([...reasons]);
}

function blockedMaterialContext(candidateSha, changedPaths, riskProfile, preflightReasons) {
  const uniqueChangedPaths = [...new Set(changedPaths.map((value) => String(value).trim()).filter(Boolean))];
  return Object.freeze({
    schemaVersion: 2,
    candidateSha,
    strategy: 'blocked-before-supplemental-context-fetch',
    limits: auditContextLimitsForRisk(riskProfile),
    totalBytes: 0,
    dependencyProbes: 0,
    representedPaths: Object.freeze([]),
    files: Object.freeze([]),
    chunks: Object.freeze([]),
    chunkedPaths: Object.freeze([]),
    omitted: Object.freeze(uniqueChangedPaths.map((filePath) => Object.freeze({
      path: filePath,
      kind: 'changed',
      reason: 'bounded-diff-preflight-blocked',
      importedBy: null
    }))),
    preflightReasons: Object.freeze([...preflightReasons])
  });
}

function auditContextPayload({ budget, diffEvidence, materialContext }) {
  return {
    bundleContext: {
      limits: budget.limits,
      totalBytes: budget.totalBytes,
      issueBody: budget.issue.bodyContext,
      pullRequestBody: budget.pullRequest.bodyContext,
      modelInvocationAllowed: budget.allowed,
      blockingReasons: budget.reasons
    },
    diffContext: {
      strategy: diffEvidence.manifest.strategy,
      limits: diffEvidence.manifest.limits,
      fullDiffBytes: diffEvidence.manifest.fullDiffBytes,
      fullDiffSha256: diffEvidence.manifest.fullDiffSha256,
      boundedBytes: diffEvidence.manifest.boundedBytes,
      contextReady: diffEvidence.manifest.contextReady ?? false,
      preflightReasons: diffEvidence.manifest.preflightReasons ?? [],
      alignmentExact: diffEvidence.manifest.alignmentExact,
      includedCount: diffEvidence.manifest.included.length,
      omittedCount: diffEvidence.manifest.omitted.length,
      categoryBytes: diffEvidence.manifest.categoryBytes ?? null,
      categoryReservations: diffEvidence.manifest.categoryReservations ?? null,
      reservationCoverageComplete: diffEvidence.manifest.reservationCoverageComplete ?? false,
      reservationFailureReasons: diffEvidence.manifest.reservationFailureReasons ?? []
    },
    materialContext: {
      strategy: materialContext.strategy,
      limits: materialContext.limits,
      totalBytes: materialContext.totalBytes,
      fileCount: materialContext.files.length,
      chunkCount: materialContext.chunks?.length ?? 0,
      chunkedPathCount: materialContext.chunkedPaths?.length ?? 0,
      representedPathCount: materialContext.representedPaths?.length ?? 0,
      omittedCount: materialContext.omitted.length
    }
  };
}

async function writeAuditResult(resultPath, payload) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function main() {
  const repository = requiredEnv('TARGET_REPOSITORY');
  const issueNumber = positiveInteger('TARGET_ISSUE');
  const pullRequestNumber = positiveInteger('TARGET_PR');
  const sourceWorkflowRunId = positiveInteger('SOURCE_WORKFLOW_RUN_ID');
  const workflowName = requiredEnv('SOURCE_WORKFLOW_NAME');
  const workflowPath = requiredEnv('SOURCE_WORKFLOW_PATH');
  const riskProfile = requiredEnv('AUDIT_RISK_PROFILE').toLowerCase();
  const implementerProvenance = String(process.env.IMPLEMENTER_PROVENANCE ?? 'known').trim().toLowerCase();
  if (!['known', 'legacy-unknown'].includes(implementerProvenance)) {
    throw new Error('IMPLEMENTER_PROVENANCE must be known or legacy-unknown');
  }

  const implementationAttempt = implementerProvenance === 'legacy-unknown'
    ? null
    : positiveInteger('IMPLEMENTATION_ATTEMPT');

  const implementer = implementerProvenance === 'legacy-unknown'
    ? {
        provenance: 'legacy-unknown',
        provider: null,
        workerIdentity: null,
        runId: null
      }
    : {
        provenance: 'known',
        provider: requiredEnv('IMPLEMENTER_PROVIDER').toLowerCase(),
        workerIdentity: requiredEnv('IMPLEMENTER_WORKER_IDENTITY'),
        runId: positiveInteger('IMPLEMENTER_RUN_ID')
      };

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
  const diffEvidence = boundAuditDiff(compareEvidence.diffText, compareEvidence.changedPaths);
  const diffPreflightReasons = boundedDiffPreflightReasons(diffEvidence.manifest);
  const boundedPreflightReasons = diffPreflightReasons.map((reason) => `bounded-diff:${reason}`);
  const representedPaths = boundedPreflightReasons.length === 0
    ? diffEvidence.manifest.included.map((entry) => entry.path).filter(Boolean)
    : [];
  const materialContext = boundedPreflightReasons.length === 0
    ? await fetchBoundedAuditContext(repository, candidateSha, compareEvidence.changedPaths, token, { representedPaths })
    : blockedMaterialContext(candidateSha, compareEvidence.changedPaths, riskProfile, boundedPreflightReasons);
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
    implementationAttempt,
    implementer,
    priorFindings
  });

  const contractUrl = repository === orchestratorRepository
    ? new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url)
    : new URL('../docs/delivery-v2/AUDIT_CONTRACT.md', import.meta.url);
  const contractText = await readFile(contractUrl, 'utf8');
  const files = materialBundleFiles({ request, contractText, diffEvidence, materialContext });
  const budget = evaluateAuditBundleBudget({
    riskProfile,
    issue,
    pullRequest: stablePullRequest,
    files,
    preflightReasons: boundedPreflightReasons
  });
  const contextPayload = auditContextPayload({ budget, diffEvidence, materialContext });

  if (!budget.allowed) {
    const finding = auditContextInsufficientFinding({ candidateSha, budget });
    const { candidateSha: _candidateSha, ...modelFinding } = finding;
    const finalized = finalizeGithubNativeAuditResult({
      request,
      modelResult: { decision: 'rejected', findings: [modelFinding] },
      reviewerRunId
    });
    const enrichedResult = { ...finalized.result, modelUsage: { providerCalls: 0 }, providerCalls: 0 };
    const payload = {
      schemaVersion: 1,
      repository,
      issueNumber,
      pullRequestNumber,
      sourceWorkflowRunId,
      auditWorkflowRunId: reviewerRunId,
      request,
      result: enrichedResult,
      outcome: finalized.outcome,
      modelUsage: null,
      providerCalls: 0,
      reviewerContextId: null,
      ...contextPayload
    };
    await writeAuditResult(resultPath, payload);
    process.stdout.write(`${JSON.stringify({ ok: true, pullRequestNumber, candidateSha, decision: 'rejected', providerCalls: 0, resultPath })}\n`);
    return;
  }

  let bundle;
  try {
    bundle = await prepareBundle({ files, issue: budget.issue, pullRequest: budget.pullRequest });
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
    const providerCalls = Number.isInteger(response.providerCalls) && response.providerCalls > 0
      ? response.providerCalls
      : 1;
    const enrichedResult = { ...finalized.result, modelUsage: response.usage ?? null, providerCalls };
    const payload = {
      schemaVersion: 1,
      repository,
      issueNumber,
      pullRequestNumber,
      sourceWorkflowRunId,
      auditWorkflowRunId: reviewerRunId,
      request,
      result: enrichedResult,
      outcome: finalized.outcome,
      modelUsage: response.usage ?? null,
      providerCalls,
      reviewerContextId: response.contextId,
      ...contextPayload
    };
    await writeAuditResult(resultPath, payload);
    process.stdout.write(`${JSON.stringify({ ok: true, pullRequestNumber, candidateSha: request.candidate.materialHeadSha, decision: finalized.result.decision, providerCalls, resultPath })}\n`);
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
