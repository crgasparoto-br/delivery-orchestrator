#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { computeTargetAuditReleaseGate } from '../src/v2/target-audit-lineage.mjs';

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'delivery-v2-target-audit-publisher',
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.json();
}

async function listComments(repository, issueNumber, token) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const items = await githubJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`, token);
    if (!Array.isArray(items)) throw new Error('issue comments response must be an array');
    comments.push(...items);
    if (items.length < 100) return comments;
  }
}

async function main() {
  const resultPath = requiredEnv('AUDIT_RESULT_PATH');
  const targetAuditId = requiredEnv('TARGET_AUDIT_ID');
  const controlRepository = requiredEnv('GITHUB_REPOSITORY');
  const token = requiredEnv('GITHUB_TOKEN');
  const outputPath = requiredEnv('GITHUB_OUTPUT');
  const payload = JSON.parse(await readFile(resultPath, 'utf8'));
  if (payload.targetAuditId !== targetAuditId) throw new Error('target audit id does not match resolved target');
  const gate = computeTargetAuditReleaseGate(payload);
  if (JSON.stringify(gate) !== JSON.stringify(payload.releaseGate)) throw new Error('runner release gate disagrees with publisher deterministic gate');

  const state = {
    schemaVersion: 3,
    controlRepository,
    targetAuditId: payload.targetAuditId,
    targetRepository: payload.target.repository,
    issueNumber: payload.target.issueNumber,
    pullRequestNumber: payload.target.pullRequestNumber,
    baseRef: payload.target.baseRef,
    headRef: payload.target.headRef,
    candidateSha: payload.result.candidateSha,
    mergePreviewSha: payload.target.mergePreviewSha,
    mergeCommitSha: payload.target.mergeCommitSha,
    auditWorkflowRunId: payload.auditWorkflowRunId,
    sourceWorkflowRunId: payload.sourceWorkflowRunId,
    auditAttempt: payload.auditAttempt,
    implementationAttempt: payload.implementationAttempt,
    semanticDecision: gate.semanticDecision,
    decision: gate.durableDecision,
    releaseBlocked: gate.releaseBlocked,
    blockingFindingCount: gate.blockingFindingCount,
    releaseGatePassed: gate.passed,
    requestFingerprint: payload.result.requestFingerprint,
    runtimeSha: payload.auditRuntime.runtimeSha,
    publisher: {
      workflowName: 'Delivery V2 Independent Audit',
      workflowPath: '.github/workflows/delivery-v2-independent-audit.yml',
      event: 'workflow_run'
    },
    findings: payload.result.findings
  };
  const encodedState = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const stateMarker = `<!-- delivery-v2-target-audit-state:${encodedState} -->`;
  const marker = `<!-- delivery-v2-target-independent-audit:${payload.targetAuditId}:${payload.result.candidateSha}:${payload.auditWorkflowRunId} -->`;
  const runUrl = `https://github.com/${controlRepository}/actions/runs/${payload.auditWorkflowRunId}`;
  const sourceRunUrl = `https://github.com/${payload.target.repository}/actions/runs/${payload.sourceWorkflowRunId}`;
  const blocking = payload.result.findings.filter((finding) => finding.blocksRelease === true);
  const body = [
    marker,
    stateMarker,
    '## Delivery V2 target independent audit',
    '',
    `- Lineage: \`${payload.targetAuditId}\` / \`${payload.target.repository}#${payload.target.issueNumber}\``,
    `- Target execution: \`${payload.target.repository}#${payload.target.pullRequestNumber}\``,
    `- Candidate: \`${payload.result.candidateSha}\``,
    `- Merge preview: \`${payload.target.mergePreviewSha}\``,
    `- Merge commit: \`${payload.target.mergeCommitSha}\``,
    `- Audit attempt: ${payload.auditAttempt}`,
    `- Implementation attempt: ${payload.implementationAttempt}`,
    `- Semantic decision: **${gate.semanticDecision}**`,
    `- Durable release decision: **${gate.durableDecision}**`,
    `- Deterministic release gate: **${gate.passed ? 'passed' : 'blocked'}**`,
    `- Reviewer: \`${payload.result.reviewer.workerIdentity}\` (run ${payload.result.reviewer.runId})`,
    `- Context isolation: \`${payload.result.reviewer.contextIsolation}\``,
    `- Source CI run: ${payload.sourceWorkflowRunId} (${sourceRunUrl})`,
    `- Source corroboration job: ${payload.sourceWorkflowCorroboration.jobId} / \`${payload.sourceWorkflowCorroboration.jobName}\``,
    `- Source log fingerprint: \`${payload.sourceWorkflowCorroboration.logFingerprint}\``,
    `- Source gate fingerprint: \`${payload.sourceWorkflowGateEvidence.fingerprint}\` (${payload.sourceWorkflowGateEvidence.jobs.length} jobs)`,
    `- GitHub merge-preview evidence: \`${payload.mergePreviewCommitEvidence.fingerprint}\``,
    `- Snapshot evidence: \`${payload.diffEvidence.snapshotFingerprint}\` (${payload.diffEvidence.fileCount} files)`,
    `- Audit workflow run: ${payload.auditWorkflowRunId} (${runUrl})`,
    `- Audit runtime SHA: \`${payload.auditRuntime.runtimeSha}\``,
    `- Request fingerprint: \`${payload.result.requestFingerprint}\``,
    `- Blocking findings: ${blocking.length}`,
    '',
    'Runtime fingerprints:',
    '```json',
    JSON.stringify(payload.auditRuntime, null, 2),
    '```',
    '',
    'Source gate evidence:',
    '```json',
    JSON.stringify(payload.sourceWorkflowGateEvidence, null, 2),
    '```',
    '',
    'Findings:',
    '```json',
    JSON.stringify(payload.result.findings, null, 2),
    '```'
  ].join('\n');

  const comments = await listComments(controlRepository, 27, token);
  const controllerComments = comments.filter((comment) => comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot');
  const exact = controllerComments.filter((comment) => String(comment.body ?? '').includes(marker));
  if (exact.length > 1) throw new Error('multiple durable controller comments already exist for the same target audit workflow run');
  let commentId;
  if (exact.length === 1) {
    if (!String(exact[0].body ?? '').includes(stateMarker)) throw new Error('existing idempotent controller target audit comment disagrees with current machine-readable state');
    commentId = exact[0].id;
  } else {
    const saved = await githubJson(`https://api.github.com/repos/${controlRepository}/issues/27/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    commentId = saved.id;
  }
  await appendFile(outputPath, `comment_id=${commentId}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, commentId, gate })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
