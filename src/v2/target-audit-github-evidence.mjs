import { createHash } from 'node:crypto';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/i;

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
export async function fetchJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.json();
}
async function fetchText(url, token, accept = 'application/vnd.github+json') {
  const response = await fetch(url, { headers: apiHeaders(token, accept), redirect: 'follow' });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  return response.text();
}
export function safeRepositoryPath(value, label) {
  const raw = String(value ?? '').replaceAll('\\', '/').trim();
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!raw || path.posix.isAbsolute(raw) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} is not a safe repository-relative path`);
  }
  return normalized;
}

export async function fetchFileEvidenceAtRef(repository, filePath, ref, token, { allowMissing = false } = {}) {
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

export async function fetchChangedFileEvidence(repository, pullRequestNumber, baseSha, headSha, token) {
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

export async function fetchMergePreviewCommitEvidence(config, token) {
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

export async function fetchSourceWorkflowEvidence(config, token) {
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
