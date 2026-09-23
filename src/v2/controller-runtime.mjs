import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const STATUS_STATES = new Set(['error', 'failure', 'pending', 'success']);

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}
function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}
function requiredSha(value, label) {
  const result = requiredString(value, label).toLowerCase();
  if (!SHA_RE.test(result)) throw new Error(`${label} must be a 40-character Git SHA`);
  return result;
}
function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requiredString(token, 'token')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-controller-runtime'
  };
}
async function fetchJson(url, token) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  return response.json();
}

const EXTERNAL_CI_FAILURE_RE = /(runner.{0,40}(?:lost|offline|unavailable|disconnect)|no (?:hosted )?runner|timed out waiting for (?:a )?runner|startup_failure|service unavailable|bad gateway|gateway timeout|rate limit|artifact storage quota|billing.{0,80}(?:quota|limit|disabled|suspended|payment|spending|problem|issue|failure|failed|error|exceeded|unavailable)|(?:quota|limit|spending).{0,80}billing|econnreset|etimedout|enetunreach|connection (?:reset|refused)|network.{0,40}(?:unreachable|timeout|reset)|temporary failure|secret.{0,40}(?:missing|not found))/i;
const REPOSITORY_CI_FAILURE_RE = /(assertionerror|testinglibraryelementerror|tests? (?:failed|failing)|\bfail(?:ed|ure)?\b.{0,80}(?:test|spec|assert)|error TS\d{4}|eslint|lint(?:ing)? (?:error|failed)|type(?:check| error)|build failed|compilation failed|compile error|migration.{0,40}failed|schema.{0,40}failed|could not find (?:chrome|chromium)|browser executable.{0,40}(?:missing|not found)|puppeteer.{0,80}(?:cache|browser).{0,40}(?:missing|not found))/i;

export function ciFailureClassForEvidence({ conclusion, failedJobs = [] } = {}) {
  if (String(conclusion ?? '').toLowerCase() !== 'failure') return 'external';
  if (!Array.isArray(failedJobs) || failedJobs.length === 0) return 'external';
  const corpus = failedJobs.map((job) => [job?.name, ...(job?.failedStepNames ?? []), job?.log].filter(Boolean).join('\n')).join('\n');
  if (!corpus.trim() || EXTERNAL_CI_FAILURE_RE.test(corpus)) return 'external';
  return REPOSITORY_CI_FAILURE_RE.test(corpus) ? 'actionable' : 'external';
}

export async function collectCiFailureEvidence({ repository, check, token } = {}) {
  const detailsUrl = String(check?.details_url ?? '');
  const runMatch = detailsUrl.match(/\/actions\/runs\/(\d+)/);
  if (!runMatch) return Object.freeze({ workflowRunId: null, workflowUrl: null, failedJobs: Object.freeze([]) });
  const runId = requiredPositiveInteger(runMatch[1], 'workflow run id from check');
  const repo = requiredString(repository, 'repository');
  const payload = await fetchJson(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const failedJobs = [];
  for (const job of (payload.jobs ?? []).filter((item) => String(item?.conclusion ?? '').toLowerCase() === 'failure')) {
    let log = '';
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${requiredPositiveInteger(job.id, 'job.id')}/logs`, { headers: githubHeaders(token) });
      if (response.ok) log = (await response.text()).slice(-200000);
    } catch {
      log = '';
    }
    failedJobs.push(Object.freeze({
      id: job.id,
      name: String(job.name ?? ''),
      failedStepNames: Object.freeze((job.steps ?? []).filter((step) => String(step?.conclusion ?? '').toLowerCase() === 'failure').map((step) => String(step.name ?? '')).filter(Boolean)),
      log
    }));
  }
  return Object.freeze({ workflowRunId: runId, workflowUrl: `https://github.com/${repo}/actions/runs/${runId}`, failedJobs: Object.freeze(failedJobs) });
}

export function createDispatchNonce() {
  return randomUUID();
}

export function expectedDispatchTitle(kind, nonce) {
  const normalizedKind = requiredString(kind, 'dispatch kind').toLowerCase();
  if (!['worker', 'audit'].includes(normalizedKind)) throw new Error('dispatch kind must be worker or audit');
  return `Delivery V2 ${normalizedKind} ${requiredString(nonce, 'dispatch nonce')}`;
}

export function selectCorrelatedWorkflowRun(runs, { kind, nonce, ref } = {}) {
  if (!Array.isArray(runs)) throw new Error('workflow runs must be an array');
  const expectedTitle = expectedDispatchTitle(kind, nonce);
  const expectedRef = requiredString(ref, 'dispatch ref');
  const matches = runs.filter((run) =>
    String(run?.event ?? '') === 'workflow_dispatch'
    && String(run?.display_title ?? '') === expectedTitle
    && String(run?.head_branch ?? '') === expectedRef
  );
  if (matches.length > 1) throw new Error(`ambiguous correlated workflow run for ${expectedTitle}`);
  return matches[0] ?? null;
}

export function validateAuditArtifactPayload(payload, {
  orchestratorRepository,
  targetRepository,
  issueNumber,
  pullRequestNumber,
  candidateSha,
  auditRunId,
  sourceWorkflowRunId
} = {}) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('audit artifact payload must be an object');
  const expectedCandidate = requiredSha(candidateSha, 'candidateSha');
  const expectedRun = requiredPositiveInteger(auditRunId, 'auditRunId');
  if (String(payload.repository ?? '') !== requiredString(targetRepository, 'targetRepository')) throw new Error('audit artifact repository mismatch');
  if (Number(payload.issueNumber) !== requiredPositiveInteger(issueNumber, 'issueNumber')) throw new Error('audit artifact issue mismatch');
  if (Number(payload.pullRequestNumber) !== requiredPositiveInteger(pullRequestNumber, 'pullRequestNumber')) throw new Error('audit artifact PR mismatch');
  if (Number(payload.auditWorkflowRunId) !== expectedRun) throw new Error('audit artifact run mismatch');
  if (Number(payload.sourceWorkflowRunId) !== requiredPositiveInteger(sourceWorkflowRunId, 'sourceWorkflowRunId')) throw new Error('audit artifact source run mismatch');
  if (String(payload.request?.candidate?.materialHeadSha ?? '').toLowerCase() !== expectedCandidate) throw new Error('audit request candidate mismatch');
  if (String(payload.result?.candidateSha ?? '').toLowerCase() !== expectedCandidate) throw new Error('audit result candidate mismatch');
  const requestFingerprint = String(payload.request?.requestFingerprint ?? '').toLowerCase();
  const resultFingerprint = String(payload.result?.requestFingerprint ?? '').toLowerCase();
  if (!FINGERPRINT_RE.test(requestFingerprint) || requestFingerprint !== resultFingerprint) throw new Error('audit request fingerprint mismatch');
  if (Number(payload.result?.reviewer?.runId) !== expectedRun) throw new Error('audit reviewer run mismatch');
  if (String(payload.result?.reviewer?.contextIsolation ?? '') !== 'candidate-contract-evidence-only') throw new Error('audit context isolation mismatch');
  if (String(payload.result?.reviewer?.workerIdentity ?? '') !== 'delivery-v2-github-native-auditor') throw new Error('audit reviewer identity mismatch');
  requiredString(orchestratorRepository, 'orchestratorRepository');
  return Object.freeze(payload.result);
}

export async function loadAuthoritativeAuditResult({
  orchestratorRepository,
  trustedRef,
  targetRepository,
  issueNumber,
  pullRequestNumber,
  candidateSha,
  auditRun,
  sourceWorkflowRunId,
  token
} = {}) {
  const repository = requiredString(orchestratorRepository, 'orchestratorRepository');
  const run = auditRun;
  if (!run || typeof run !== 'object') throw new Error('auditRun is required');
  const runId = requiredPositiveInteger(run.id, 'auditRun.id');
  if (String(run.event ?? '') !== 'workflow_dispatch') throw new Error('audit run event mismatch');
  if (String(run.path ?? '') !== '.github/workflows/delivery-v2-audit.yml') throw new Error('audit run workflow path mismatch');
  if (String(run.head_branch ?? '') !== requiredString(trustedRef, 'trustedRef')) throw new Error('audit run control-plane ref mismatch');
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('audit run must be terminal green');

  const artifacts = await fetchJson(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, token);
  const expectedName = `delivery-v2-audit-${requiredPositiveInteger(pullRequestNumber, 'pullRequestNumber')}-${runId}`;
  const matches = (artifacts.artifacts ?? []).filter((artifact) => artifact.name === expectedName && artifact.expired !== true);
  if (matches.length !== 1) throw new Error(`expected exactly one authoritative audit artifact ${expectedName}`);
  const artifact = matches[0];
  if (artifact.workflow_run?.id != null && Number(artifact.workflow_run.id) !== runId) throw new Error('audit artifact provenance run mismatch');

  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`audit artifact download failed: ${response.status}`);
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-audit-result-'));
  try {
    const zipPath = path.join(root, 'audit.zip');
    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
    execFileSync('unzip', ['-q', zipPath, '-d', root]);
    const candidates = [];
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.json')) candidates.push(full);
      }
    }
    if (candidates.length !== 1) throw new Error('authoritative audit artifact must contain exactly one JSON result');
    const payload = JSON.parse(await readFile(candidates[0], 'utf8'));
    return validateAuditArtifactPayload(payload, {
      orchestratorRepository: repository,
      targetRepository,
      issueNumber,
      pullRequestNumber,
      candidateSha,
      auditRunId: runId,
      sourceWorkflowRunId
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function releaseIdentityFromPullRequest(pullRequest, { materialHeadSha, baseSha } = {}) {
  if (!pullRequest || Array.isArray(pullRequest) || typeof pullRequest !== 'object') throw new Error('pullRequest is required');
  const expectedHead = requiredSha(materialHeadSha, 'materialHeadSha');
  const expectedBase = requiredSha(baseSha, 'baseSha');
  const currentHead = requiredSha(pullRequest.head?.sha, 'pullRequest.head.sha');
  const currentBase = requiredSha(pullRequest.base?.sha, 'pullRequest.base.sha');
  if (currentHead !== expectedHead) throw new Error('release head drift detected');
  if (currentBase !== expectedBase) throw new Error('release base drift detected');
  const rawPreview = String(pullRequest.merge_commit_sha ?? '').trim().toLowerCase();
  const previewSha = SHA_RE.test(rawPreview) ? rawPreview : null;
  const evidenceRef = requiredString(pullRequest.html_url ?? pullRequest.url ?? ('github:pull:' + (pullRequest.number ?? 'unknown')), 'pullRequest evidence URL');
  return Object.freeze({
    currentRemoteHeadSha: currentHead,
    currentBaseSha: currentBase,
    mergePreview: Object.freeze({
      required: true,
      materialHeadSha: expectedHead,
      previewSha,
      status: 'pending',
      conclusion: null,
      evidenceRef
    })
  });
}

export function mergePreviewEvidenceFromWorkflow({ pullRequest, materialHeadSha, baseSha, workflowRun, jobs = [], requiredJobName, jobLogById = {} } = {}) {
  const identity = releaseIdentityFromPullRequest(pullRequest, { materialHeadSha, baseSha });
  if (!identity.mergePreview.previewSha) return identity.mergePreview;
  if (!workflowRun || typeof workflowRun !== 'object' || Array.isArray(workflowRun)) throw new Error('merge-preview source workflow run is required');
  const expectedHead = requiredSha(materialHeadSha, 'materialHeadSha');
  const expectedBase = requiredSha(baseSha, 'baseSha');
  if (String(workflowRun.event ?? '') !== 'pull_request') throw new Error('merge-preview evidence must come from a pull_request workflow run');
  if (requiredSha(workflowRun.head_sha, 'workflowRun.head_sha') !== expectedHead) throw new Error('merge-preview workflow run head mismatch');
  const prNumber = requiredPositiveInteger(pullRequest.number, 'pullRequest.number');
  const runPr = (workflowRun.pull_requests ?? []).find((item) => Number(item?.number) === prNumber);
  if (!runPr) throw new Error('merge-preview workflow run is not bound to the target PR');
  if (requiredSha(runPr.head?.sha, 'workflowRun.pullRequest.head.sha') !== expectedHead) throw new Error('merge-preview workflow PR head mismatch');
  if (requiredSha(runPr.base?.sha, 'workflowRun.pullRequest.base.sha') !== expectedBase) throw new Error('merge-preview workflow PR base mismatch');
  if (!Array.isArray(jobs)) throw new Error('merge-preview jobs must be an array');
  const jobName = requiredString(requiredJobName, 'requiredJobName');
  const matches = jobs.filter((job) => String(job?.name ?? '') === jobName);
  if (matches.length > 1) throw new Error('ambiguous merge-preview validation jobs');
  const job = matches[0];
  if (!job) return identity.mergePreview;
  const jobId = requiredPositiveInteger(job.id, 'merge-preview job.id');
  const log = String(jobLogById?.[jobId] ?? '');
  const previewSha = identity.mergePreview.previewSha;
  const prMergeRef = `refs/pull/${prNumber}/merge`;
  if (!log.includes(previewSha) || (!log.includes(prMergeRef) && !log.includes(`pull/${prNumber}/merge`))) {
    return identity.mergePreview;
  }
  return Object.freeze({
    ...identity.mergePreview,
    status: String(job.status ?? '').toLowerCase() || 'pending',
    conclusion: job.conclusion == null ? null : String(job.conclusion).toLowerCase(),
    evidenceRef: requiredString(job.html_url ?? workflowRun.html_url, 'merge-preview job evidence URL')
  });
}

export async function collectMergePreviewEvidence({ repository, pullRequest, materialHeadSha, baseSha, workflowRun, requiredJobName, token } = {}) {
  const repo = requiredString(repository, 'repository');
  const runId = requiredPositiveInteger(workflowRun?.id, 'workflowRun.id');
  const payload = await fetchJson(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const jobs = payload.jobs ?? [];
  const jobName = requiredString(requiredJobName, 'requiredJobName');
  const matchingJobs = jobs.filter((job) => String(job?.name ?? '') === jobName);
  if (matchingJobs.length > 1) throw new Error('ambiguous merge-preview validation jobs');
  const jobLogById = {};
  if (matchingJobs[0]) {
    const jobId = requiredPositiveInteger(matchingJobs[0].id, 'merge-preview job.id');
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, { headers: githubHeaders(token) });
    if (response.ok) jobLogById[jobId] = (await response.text()).slice(-300000);
  }
  return mergePreviewEvidenceFromWorkflow({ pullRequest, materialHeadSha, baseSha, workflowRun, jobs, requiredJobName, jobLogById });
}

export async function publishReleaseStatus({ repository, sha, context, state, description, token, targetUrl = null } = {}) {
  const status = requiredString(state, 'status state').toLowerCase();
  if (!STATUS_STATES.has(status)) throw new Error('status state must be error, failure, pending, or success');
  const body = {
    state: status,
    context: requiredString(context, 'status context'),
    description: requiredString(description, 'status description').slice(0, 140)
  };
  if (targetUrl) body.target_url = requiredString(targetUrl, 'targetUrl');
  const response = await fetch(`https://api.github.com/repos/${requiredString(repository, 'repository')}/statuses/${requiredSha(sha, 'status sha')}`, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} POST commit status: ${await response.text()}`);
  return response.json();
}