import { createHash } from 'node:crypto';

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function headers(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${requiredString(token, 'token')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-github-audit-evidence'
  };
}

async function responseText(response) {
  return response.text();
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await responseText(response)}`);
  return response.json();
}

async function fetchText(url, token, accept) {
  const response = await fetch(url, { headers: headers(token, accept) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await responseText(response)}`);
  return response.text();
}

export async function fetchFileEvidenceAtRef(repository, filePath, ref, token) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const payload = await fetchJson(`https://api.github.com/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, token);
  if (payload.type !== 'file' || payload.encoding !== 'base64') throw new Error(`expected base64 file for ${filePath}@${ref}`);
  return {
    ref: String(ref).toLowerCase(),
    path: filePath,
    blobSha: String(payload.sha).toLowerCase(),
    content: Buffer.from(payload.content, 'base64').toString('utf8')
  };
}

export async function fetchAuditClassifier(repository, ref, token, { orchestratorRepository } = {}) {
  try {
    const evidence = await fetchFileEvidenceAtRef(repository, '.delivery-v2/lock.json', ref, token);
    const lock = JSON.parse(evidence.content);
    const fingerprint = String(lock.canonicalClassifierFingerprint ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('target .delivery-v2/lock.json lacks canonicalClassifierFingerprint');
    return {
      version: `${lock.source?.repository ?? 'unknown'}@${lock.source?.commit ?? 'unknown'}`,
      fingerprint,
      evidence
    };
  } catch (error) {
    if (repository !== requiredString(orchestratorRepository, 'orchestratorRepository')) throw error;
    const evidence = await fetchFileEvidenceAtRef(repository, 'src/v2/risk-profile.mjs', ref, token);
    return {
      version: 'delivery-v2-risk-profile-v1',
      fingerprint: createHash('sha256').update(Buffer.from(evidence.content, 'utf8')).digest('hex'),
      evidence
    };
  }
}

export async function fetchImmutableCompareEvidence(repository, baseSha, candidateSha, token) {
  const base = requiredString(baseSha, 'baseSha').toLowerCase();
  const head = requiredString(candidateSha, 'candidateSha').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) throw new Error('compare refs must be exact 40-character Git SHAs');
  const url = `https://api.github.com/repos/${repository}/compare/${base}...${head}`;
  const payload = await fetchJson(url, token);
  const files = payload.files ?? [];
  if (files.length === 0) throw new Error('audited candidate has no changed paths');
  if (files.length >= 300) throw new Error('immutable compare reached GitHub file cap; refusing incomplete audit evidence');
  const observedBase = String(payload.base_commit?.sha ?? '').toLowerCase();
  if (observedBase && observedBase !== base) throw new Error('immutable compare base identity mismatch');
  const observedHead = String((payload.commits ?? []).at(-1)?.sha ?? '').toLowerCase();
  if (observedHead && observedHead !== head) throw new Error('immutable compare candidate identity mismatch');
  const diffText = await fetchText(url, token, 'application/vnd.github.v3.diff');
  return Object.freeze({
    baseSha: base,
    candidateSha: head,
    changedPaths: Object.freeze(files.map((file) => String(file.filename))),
    diffText
  });
}

export function assertPullRequestSnapshotStable(initialPullRequest, finalPullRequest) {
  const initialHead = String(initialPullRequest?.head?.sha ?? '').toLowerCase();
  const finalHead = String(finalPullRequest?.head?.sha ?? '').toLowerCase();
  const initialBase = String(initialPullRequest?.base?.sha ?? '').toLowerCase();
  const finalBase = String(finalPullRequest?.base?.sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(initialHead) || !/^[0-9a-f]{40}$/.test(initialBase)) throw new Error('initial PR snapshot lacks exact SHA identity');
  if (initialHead !== finalHead || initialBase !== finalBase) throw new Error('pull request head/base changed while collecting audit evidence');
  return Object.freeze({ candidateSha: initialHead, baseSha: initialBase });
}
