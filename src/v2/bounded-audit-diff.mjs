import { createHash } from 'node:crypto';

export const DEFAULT_AUDIT_DIFF_LIMITS = Object.freeze({
  maxFiles: 40,
  maxFileBytes: 24 * 1024,
  maxTotalBytes: 64 * 1024
});

export const STANDARD_AUDIT_DIFF_LIMITS = Object.freeze({
  maxFiles: 24,
  maxFileBytes: 12 * 1024,
  maxTotalBytes: 32 * 1024
});

const GENERATED_LOW_VALUE_PATTERNS = Object.freeze([
  /(?:^|\/)\.audit(?:\/|$)/,
  /(?:^|\/)skills\/catalog(?:\/|$)/,
  /(?:^|\/)\.generated(?:\/|$)/,
  /\.lock\.ya?ml$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)\.github\/aw\/actions-lock\.json$/
]);
const WORKER_PROMPT_PATTERN = /^\.github\/workflows\/delivery-v2-worker-(?:claude|codex|copilot)-(?:fast|standard|critical)\.md$/;
const SEMANTIC_CATEGORY_ORDER = Object.freeze(['executable', 'tests', 'config', 'evidence', 'docs', 'prompts', 'other']);

export function auditDiffLimitsForRisk(riskProfile) {
  const risk = String(riskProfile ?? '').trim().toLowerCase();
  if (!risk || risk === 'critical') return DEFAULT_AUDIT_DIFF_LIMITS;
  if (risk === 'standard') return STANDARD_AUDIT_DIFF_LIMITS;
  throw new Error(`unsupported audit diff risk profile: ${risk || '(missing)'}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLimits(limits = {}) {
  const resolved = { ...auditDiffLimitsForRisk(process.env.AUDIT_RISK_PROFILE), ...limits };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`audit diff ${key} must be a positive integer`);
  }
  return Object.freeze(resolved);
}

function splitDiffBlocks(diffText) {
  const text = String(diffText ?? '');
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) return text ? [text] : [];
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

function decodeDiffPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/dev/null') return null;
  let decoded = raw;
  if (decoded.startsWith('"')) {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  if (decoded.startsWith('a/') || decoded.startsWith('b/')) decoded = decoded.slice(2);
  return decoded || null;
}

function diffBlockPath(block) {
  const lines = String(block ?? '').split('\n');
  for (const prefix of ['+++ ', '--- ']) {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (!line) continue;
    const parsed = decodeDiffPath(line.slice(prefix.length));
    if (parsed) return parsed;
  }
  return null;
}

function generatedLowValuePath(filePath) {
  const value = String(filePath ?? '');
  return GENERATED_LOW_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function semanticCategory(filePath) {
  const value = String(filePath ?? '');
  if (/^(?:test|tests|__tests__)\//.test(value) || /(?:^|\/)[^/]*\.test\.[^/]+$/.test(value) || /(?:^|\/)[^/]*\.spec\.[^/]+$/.test(value)) return 'tests';
  if (/^docs\/delivery-v2\/evidence\//.test(value)) return 'evidence';
  if (WORKER_PROMPT_PATTERN.test(value)) return 'prompts';
  if (/^(?:src|scripts|actions)\//.test(value) || /^\.github\/scripts\//.test(value)) return 'executable';
  if (/^(?:config|schemas)\//.test(value)) return 'config';
  if (/^\.github\/workflows\//.test(value)) return 'config';
  if (/^(?:docs|README)/.test(value)) return 'docs';
  return 'other';
}

export function boundAuditDiff(diffText, changedPaths, { limits } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');
  const text = String(diffText ?? '');
  const resolvedLimits = normalizeLimits(limits);
  const blocks = splitDiffBlocks(text);
  const normalizedChangedPaths = changedPaths.map((value) => String(value).trim()).filter(Boolean);
  const changedPathSet = new Set(normalizedChangedPaths);
  const parsedBlockPaths = blocks.map(diffBlockPath);
  const parsedPathSet = new Set(parsedBlockPaths.filter(Boolean));
  const alignmentExact = blocks.length === normalizedChangedPaths.length
    && changedPathSet.size === normalizedChangedPaths.length
    && parsedBlockPaths.every(Boolean)
    && parsedPathSet.size === parsedBlockPaths.length
    && parsedPathSet.size === changedPathSet.size
    && parsedBlockPaths.every((filePath) => changedPathSet.has(filePath));

  const entries = blocks.map((block, index) => {
    const parsedPath = parsedBlockPaths[index];
    const path = parsedPath && changedPathSet.has(parsedPath) ? parsedPath : null;
    return {
      index,
      path,
      block,
      bytes: Buffer.byteLength(block, 'utf8'),
      sha256: sha256(block),
      category: path ? semanticCategory(path) : 'other'
    };
  });

  const included = [];
  const omitted = [];
  const includedIndexes = new Set();
  let totalBytes = 0;
  const categoryBytes = Object.fromEntries(SEMANTIC_CATEGORY_ORDER.map((category) => [category, 0]));

  function include(entry) {
    if (includedIndexes.has(entry.index)) return false;
    if (included.length >= resolvedLimits.maxFiles) return false;
    if (totalBytes + entry.bytes > resolvedLimits.maxTotalBytes) return false;
    includedIndexes.add(entry.index);
    included.push(entry);
    totalBytes += entry.bytes;
    categoryBytes[entry.category] += entry.bytes;
    return true;
  }

  const eligible = [];
  for (const entry of entries) {
    if (entry.path && generatedLowValuePath(entry.path)) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason: 'generated-low-value' });
      continue;
    }
    if (entry.bytes > resolvedLimits.maxFileBytes) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason: 'max-file-bytes' });
      continue;
    }
    eligible.push(entry);
  }

  const reservationCandidates = new Map();
  if (alignmentExact) {
    for (const category of SEMANTIC_CATEGORY_ORDER) {
      const candidates = eligible
        .filter((entry) => entry.category === category)
        .sort((a, b) => a.bytes - b.bytes || a.index - b.index);
      if (candidates.length > 0) reservationCandidates.set(category, candidates[0]);
    }
    for (const category of SEMANTIC_CATEGORY_ORDER) {
      const representative = reservationCandidates.get(category);
      if (representative) include(representative);
    }
  }

  const spillover = alignmentExact
    ? eligible
      .filter((entry) => !includedIndexes.has(entry.index))
      .sort((a, b) => SEMANTIC_CATEGORY_ORDER.indexOf(a.category) - SEMANTIC_CATEGORY_ORDER.indexOf(b.category) || a.index - b.index)
    : eligible;
  for (const entry of spillover) include(entry);

  for (const entry of eligible) {
    if (includedIndexes.has(entry.index)) continue;
    const reason = included.length >= resolvedLimits.maxFiles ? 'max-files' : 'max-total-bytes';
    omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason });
  }

  const orderedIncluded = [...included].sort((a, b) => a.index - b.index);
  const categoryReservations = Object.freeze(Object.fromEntries(SEMANTIC_CATEGORY_ORDER.map((category) => {
    const representative = reservationCandidates.get(category);
    return [category, Object.freeze({
      required: Boolean(representative),
      path: representative?.path ?? null,
      bytes: representative?.bytes ?? 0,
      included: Boolean(representative && includedIndexes.has(representative.index))
    })];
  })));
  const boundedText = orderedIncluded.map((entry) => entry.block).join('');
  const manifest = Object.freeze({
    schemaVersion: 3,
    strategy: alignmentExact ? 'bounded-semantic-class-representative-unified-diff' : 'bounded-unified-diff-unverified-path-alignment',
    limits: resolvedLimits,
    categoryReservations,
    categoryBytes: Object.freeze(categoryBytes),
    fullDiffBytes: Buffer.byteLength(text, 'utf8'),
    fullDiffSha256: sha256(text),
    changedPathCount: normalizedChangedPaths.length,
    blockCount: blocks.length,
    alignmentExact,
    boundedBytes: totalBytes,
    included: Object.freeze(orderedIncluded.map(({ block, ...entry }) => Object.freeze(entry))),
    omitted: Object.freeze(omitted.sort((a, b) => a.index - b.index).map((entry) => Object.freeze(entry))),
    changedPaths: Object.freeze(normalizedChangedPaths)
  });

  return Object.freeze({ text: boundedText, manifest });
}
