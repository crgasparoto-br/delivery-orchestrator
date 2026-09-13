import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';

const AUDIT_CONTEXT_TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.graphql', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.sh', '.sql', '.toml', '.ts', '.tsx', '.yaml', '.yml'
]);
const AUDIT_CONTEXT_GENERATED_PATTERNS = [
  /(?:^|\/)\.audit(?:\/|$)/,
  /(?:^|\/)skills\/catalog(?:\/|$)/,
  /(?:^|\/)\.generated(?:\/|$)/,
  /\.lock\.ya?ml$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)\.github\/aw\/actions-lock\.json$/
];
const WORKER_PROMPT_PATTERN = /^\.github\/workflows\/delivery-v2-worker-(?:claude|codex|copilot)-(?:fast|standard|critical)\.md$/;
const DIRECT_IMPORT_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
const SEMANTIC_CATEGORY_ORDER = Object.freeze(['executable', 'tests', 'config', 'evidence', 'docs', 'prompts', 'other']);

export const DEFAULT_AUDIT_CONTEXT_LIMITS = Object.freeze({
  maxFiles: 24,
  maxFileBytes: 24 * 1024,
  maxTotalBytes: 96 * 1024,
  maxDependencyProbes: 24
});

export const STANDARD_AUDIT_CONTEXT_LIMITS = Object.freeze({
  maxFiles: 16,
  maxFileBytes: 16 * 1024,
  maxTotalBytes: 48 * 1024,
  maxDependencyProbes: 12
});

export function auditContextLimitsForRisk(riskProfile) {
  const risk = String(riskProfile ?? '').trim().toLowerCase();
  if (!risk || risk === 'critical') return DEFAULT_AUDIT_CONTEXT_LIMITS;
  if (risk === 'standard') return STANDARD_AUDIT_CONTEXT_LIMITS;
  throw new Error(`unsupported audit context risk profile: ${risk || '(missing)'}`);
}

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
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status} for ${url}: ${await responseText(response)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchText(url, token, accept) {
  const response = await fetch(url, { headers: headers(token, accept) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${await responseText(response)}`);
  return response.text();
}

function normalizeAuditContextLimits(limits = {}) {
  const merged = { ...auditContextLimitsForRisk(process.env.AUDIT_RISK_PROFILE), ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`audit context ${key} must be a positive integer`);
  }
  return Object.freeze(merged);
}

function auditContextCategory(filePath) {
  if (/^(?:src|scripts|actions)\//.test(filePath) || /^\.github\/scripts\//.test(filePath)) return 'executable';
  if (/^(?:test|tests|__tests__)\//.test(filePath) || /(?:^|\/)test\./.test(filePath)) return 'tests';
  if (/^docs\/delivery-v2\/evidence\//.test(filePath)) return 'evidence';
  if (/^(?:config|schemas)\//.test(filePath)) return 'config';
  if (/^\.github\/workflows\//.test(filePath) && !WORKER_PROMPT_PATTERN.test(filePath)) return 'config';
  if (/^(?:docs|README)/.test(filePath)) return 'docs';
  if (WORKER_PROMPT_PATTERN.test(filePath)) return 'prompts';
  return 'other';
}

function fairChangedPathOrder(paths) {
  const buckets = new Map(SEMANTIC_CATEGORY_ORDER.map((category) => [category, []]));
  for (const filePath of paths) buckets.get(auditContextCategory(filePath)).push(filePath);
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.localeCompare(b));
  const ordered = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const category of SEMANTIC_CATEGORY_ORDER) {
      const bucket = buckets.get(category);
      if (bucket.length > 0) {
        ordered.push(bucket.shift());
        remaining = true;
      }
    }
  }
  return ordered;
}

function auditContextPathAllowed(filePath) {
  const normalized = pathPosix.normalize(String(filePath ?? '').replace(/^\.\//, ''));
  if (!normalized || normalized.startsWith('../') || normalized.startsWith('/')) return false;
  if (AUDIT_CONTEXT_GENERATED_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return AUDIT_CONTEXT_TEXT_EXTENSIONS.has(pathPosix.extname(normalized).toLowerCase());
}

function directRelativeImportSpecifiers(content) {
  const found = new Set();
  const text = String(content ?? '');
  const patterns = [
    /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*['"](\.{1,2}\/[^'"?#]+)['"]/g,
    /\bimport\s+['"](\.{1,2}\/[^'"?#]+)['"]/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function dependencyCandidates(importerPath, specifier) {
  const base = pathPosix.normalize(pathPosix.join(pathPosix.dirname(importerPath), specifier));
  if (!base || base.startsWith('../') || base.startsWith('/')) return [];
  if (pathPosix.extname(base)) return [base];
  return [
    base,
    ...DIRECT_IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...DIRECT_IMPORT_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  ];
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

async function fetchOptionalFileEvidenceAtRef(repository, filePath, ref, token) {
  try {
    return await fetchFileEvidenceAtRef(repository, filePath, ref, token);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export async function fetchBoundedAuditContext(repository, ref, changedPaths, token, { limits, representedPaths = [] } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');
  if (!Array.isArray(representedPaths)) throw new Error('representedPaths must be an array');
  const candidateSha = requiredString(ref, 'ref').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) throw new Error('audit context ref must be an exact 40-character Git SHA');
  const resolvedLimits = normalizeAuditContextLimits(limits);
  const allChangedPaths = [...new Set(changedPaths.map((value) => String(value).trim()).filter(Boolean))];
  const changedPathSet = new Set(allChangedPaths);
  const represented = new Set(representedPaths.map((value) => String(value).trim()).filter(Boolean));
  for (const filePath of represented) {
    if (!changedPathSet.has(filePath)) throw new Error(`represented audit path is not changed: ${filePath}`);
  }
  const allowedChangedPaths = allChangedPaths.filter(auditContextPathAllowed);
  const orderedChangedPaths = fairChangedPathOrder(allowedChangedPaths.filter((filePath) => !represented.has(filePath)));
  const files = [];
  const omitted = allChangedPaths
    .filter((filePath) => !auditContextPathAllowed(filePath))
    .map((filePath) => ({ path: filePath, kind: 'changed', reason: 'non-material-or-generated', importedBy: null }));
  for (const filePath of allowedChangedPaths.filter((filePath) => represented.has(filePath))) {
    omitted.push({ path: filePath, kind: 'changed', reason: 'represented-in-bounded-diff', importedBy: null });
  }
  const seen = new Set(represented);
  let totalBytes = 0;

  function appendEvidence(evidence, kind, importedBy = null) {
    if (!evidence || seen.has(evidence.path)) return false;
    if (files.length >= resolvedLimits.maxFiles) {
      omitted.push({ path: evidence.path, kind, reason: 'max-files', importedBy });
      return false;
    }
    const bytes = Buffer.byteLength(evidence.content, 'utf8');
    if (bytes > resolvedLimits.maxFileBytes) {
      omitted.push({ path: evidence.path, kind, reason: 'max-file-bytes', bytes, importedBy });
      return false;
    }
    if (totalBytes + bytes > resolvedLimits.maxTotalBytes) {
      omitted.push({ path: evidence.path, kind, reason: 'max-total-bytes', bytes, importedBy });
      return false;
    }
    seen.add(evidence.path);
    totalBytes += bytes;
    files.push(Object.freeze({
      path: evidence.path,
      blobSha: evidence.blobSha,
      kind,
      importedBy,
      category: auditContextCategory(evidence.path),
      bytes,
      content: evidence.content
    }));
    return true;
  }

  for (const filePath of orderedChangedPaths) {
    if (files.length >= resolvedLimits.maxFiles || totalBytes >= resolvedLimits.maxTotalBytes) {
      omitted.push({ path: filePath, kind: 'changed', reason: 'context-budget', importedBy: null });
      continue;
    }
    const evidence = await fetchOptionalFileEvidenceAtRef(repository, filePath, ref, token);
    if (!evidence) {
      omitted.push({ path: filePath, kind: 'changed', reason: 'not-present-at-candidate', importedBy: null });
      continue;
    }
    appendEvidence(evidence, 'changed');
  }

  const dependencySeeds = files.filter((item) => item.kind === 'changed');
  for (const filePath of allowedChangedPaths.filter((item) => represented.has(item) && auditContextCategory(item) === 'executable')) {
    const evidence = await fetchOptionalFileEvidenceAtRef(repository, filePath, ref, token);
    if (evidence) dependencySeeds.push(evidence);
  }

  let dependencyProbes = 0;
  dependencyLoop:
  for (const changedFile of dependencySeeds) {
    for (const specifier of directRelativeImportSpecifiers(changedFile.content)) {
      for (const candidate of dependencyCandidates(changedFile.path, specifier)) {
        if (dependencyProbes >= resolvedLimits.maxDependencyProbes || files.length >= resolvedLimits.maxFiles || totalBytes >= resolvedLimits.maxTotalBytes) break dependencyLoop;
        dependencyProbes += 1;
        if (seen.has(candidate) || !auditContextPathAllowed(candidate)) continue;
        const evidence = await fetchOptionalFileEvidenceAtRef(repository, candidate, ref, token);
        if (!evidence) continue;
        appendEvidence(evidence, 'direct-relative-dependency', changedFile.path);
        break;
      }
    }
  }

  return Object.freeze({
    schemaVersion: 2,
    candidateSha,
    strategy: 'supplemental-changed-files-plus-direct-relative-dependencies',
    limits: resolvedLimits,
    totalBytes,
    dependencyProbes,
    representedPaths: Object.freeze([...represented]),
    files: Object.freeze(files),
    omitted: Object.freeze(omitted)
  });
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
