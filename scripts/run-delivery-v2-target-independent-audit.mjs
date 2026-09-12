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
  normalizeTargetAuditConfig
} from '../src/v2/target-independent-audit-runtime.mjs';
import {
  buildLineageTargetCriticalAuditRequest,
  computeTargetAuditReleaseGate,
  deriveTargetAuditProgress,
  fetchControllerOwnedTargetAuditStates
} from '../src/v2/target-audit-lineage.mjs';
import {
  fetchChangedFileEvidence,
  fetchFileEvidenceAtRef,
  fetchJson,
  fetchMergePreviewCommitEvidence,
  fetchSourceWorkflowEvidence,
  safeRepositoryPath
} from '../src/v2/target-audit-github-evidence.mjs';

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
  const lineageRuntimeText = await readFile(new URL('../src/v2/target-audit-lineage.mjs', import.meta.url), 'utf8');
  const workflowText = await readFile(new URL('../.github/workflows/delivery-v2-independent-audit.yml', import.meta.url), 'utf8');
  return Object.freeze({
    contractText,
    evidence: Object.freeze({
      runtimeSha,
      contractFingerprint: fingerprintText(contractText),
      targetConfigFingerprint: fingerprintText(targetConfigText),
      runnerFingerprint: fingerprintText(runnerText),
      targetRuntimeFingerprint: fingerprintText(targetRuntimeText),
      lineageRuntimeFingerprint: fingerprintText(lineageRuntimeText),
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
    `The authoritative candidate code evidence is the complete exact-SHA file snapshots under snapshots/base and snapshots/head. CHANGED_FILES.json maps every changed path to immutable blob/content fingerprints; DIFF_COVERAGE.json binds the exhaustive inventory and snapshot set. Do not infer completeness from GitHub patch snippets. AUDIT_RUNTIME_EVIDENCE.json pins the audit runtime and contract/config/runtime fingerprints. PRIOR_TARGET_AUDITS.json contains only controller-owned durable prior target-audit state from the same stable target lineage. Candidate-specific SHAs may change between remediation attempts, but the lineage id and target subject remain stable and attempts/findings carry forward. The same material candidate is never re-audited after an authoritative durable state.\n\n` +
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
  const persistedStates = await fetchControllerOwnedTargetAuditStates({ controlRepository, issueNumber: 27, token: githubToken });
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

  const request = buildLineageTargetCriticalAuditRequest({
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
    const releaseGate = computeTargetAuditReleaseGate(finalized);
    const evidence = {
      schemaVersion: 3,
      targetAuditId,
      target: {
        repository: config.repository,
        issueNumber: config.issueNumber,
        pullRequestNumber: config.pullRequestNumber,
        baseRef: config.baseRef,
        headRef: config.headRef,
        materialHeadSha: config.materialHeadSha,
        mergePreviewSha: config.mergePreviewSha,
        mergeCommitSha: config.mergeCommitSha
      },
      auditAttempt: progress.auditAttempt,
      implementationAttempt: progress.implementationAttempt,
      releaseGate,
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
    process.stdout.write(`${JSON.stringify({ ok: true, targetAuditId, repository: config.repository, pullRequestNumber: config.pullRequestNumber, candidateSha: config.materialHeadSha, mergePreviewSha: config.mergePreviewSha, auditAttempt: progress.auditAttempt, semanticDecision: finalized.result.decision, durableDecision: releaseGate.durableDecision, releaseBlocked: releaseGate.releaseBlocked, blockingFindingCount: releaseGate.blockingFindingCount, requestFingerprint: request.requestFingerprint, runtimeSha, resultPath })}\n`);
  } finally {
    if (bundle) await rm(bundle, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
