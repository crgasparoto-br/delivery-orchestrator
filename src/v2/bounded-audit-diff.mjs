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
const SEMANTIC_CATEGORY_WEIGHTS = Object.freeze({
  executable: 5,
  tests: 3,
  config: 2,
  evidence: 2,
  docs: 2,
  prompts: 2,
  other: 1
});

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

function generatedLowValuePath(filePath) {
  const value = String(filePath ?? '');
  return GENERATED_LOW_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function semanticCategory(filePath) {
  const value = String(filePath ?? '');
  if (/^(?:src|scripts|actions)\//.test(value) || /^\.github\/scripts\//.test(value)) return 'executable';
  if (/^(?:test|tests|__tests__)\//.test(value) || /(?:^|\/)test\./.test(value)) return 'tests';
  if (/^docs\/delivery-v2\/evidence\//.test(value)) return 'evidence';
  if (/^(?:config|schemas)\//.test(value)) return 'config';
  if (/^\.github\/workflows\//.test(value) && !WORKER_PROMPT_PATTERN.test(value)) return 'config';
  if (/^(?:docs|README)/.test(value)) return 'docs';
  if (WORKER_PROMPT_PATTERN.test(value)) return 'prompts';
  return 'other';
}

function categoryBudgets(maxTotalBytes) {
  const weightTotal = Object.values(SEMANTIC_CATEGORY_WEIGHTS).reduce((sum, value) => sum + value, 0);
  const result = {};
  let assigned = 0;
  for (const category of SEMANTIC_CATEGORY_ORDER) {
    const value = Math.floor((maxTotalBytes * SEMANTIC_CATEGORY_WEIGHTS[category]) / weightTotal);
    result[category] = value;
    assigned += value;
  }
  result.executable += maxTotalBytes - assigned;
  return Object.freeze(result);
}

export function boundAuditDiff(diffText, changedPaths, { limits } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');
  const text = String(diffText ?? '');
  const resolvedLimits = normalizeLimits(limits);
  const blocks = splitDiffBlocks(text);
  const alignmentExact = blocks.length === changedPaths.length;
  const entries = blocks.map((block, index) => ({
    index,
    path: alignmentExact ? String(changedPaths[index]) : null,
    block,
    bytes: Buffer.byteLength(block, 'utf8'),
    sha256: sha256(block),
    category: alignmentExact ? semanticCategory(changedPaths[index]) : 'other'
  }));

  const included = [];
  const omitted = [];
  const includedIndexes = new Set();
  let totalBytes = 0;
  const budgets = categoryBudgets(resolvedLimits.maxTotalBytes);
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
    if (alignmentExact && generatedLowValuePath(entry.path)) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason: 'generated-low-value' });
      continue;
    }
    if (entry.bytes > resolvedLimits.maxFileBytes) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason: 'max-file-bytes' });
      continue;
    }
    eligible.push(entry);
  }

  if (alignmentExact) {
    for (const category of SEMANTIC_CATEGORY_ORDER) {
      for (const entry of eligible.filter((item) => item.category === category)) {
        if (included.length >= resolvedLimits.maxFiles) break;
        if (categoryBytes[category] + entry.bytes > budgets[category]) continue;
        include(entry);
      }
    }
  }

  const spillover = alignmentExact
    ? eligible.filter((entry) => !includedIndexes.has(entry.index)).sort((a, b) => SEMANTIC_CATEGORY_ORDER.indexOf(a.category) - SEMANTIC_CATEGORY_ORDER.indexOf(b.category) || a.index - b.index)
    : eligible;
  for (const entry of spillover) include(entry);

  for (const entry of eligible) {
    if (includedIndexes.has(entry.index)) continue;
    const reason = included.length >= resolvedLimits.maxFiles ? 'max-files' : 'max-total-bytes';
    omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason });
  }

  const orderedIncluded = [...included].sort((a, b) => a.index - b.index);
  const boundedText = orderedIncluded.map((entry) => entry.block).join('');
  const manifest = Object.freeze({
    schemaVersion: 2,
    strategy: alignmentExact ? 'bounded-semantic-class-reserved-unified-diff' : 'bounded-unified-diff',
    limits: resolvedLimits,
    categoryBudgets: budgets,
    categoryBytes: Object.freeze(categoryBytes),
    fullDiffBytes: Buffer.byteLength(text, 'utf8'),
    fullDiffSha256: sha256(text),
    changedPathCount: changedPaths.length,
    blockCount: blocks.length,
    alignmentExact,
    boundedBytes: totalBytes,
    included: Object.freeze(orderedIncluded.map(({ block, ...entry }) => Object.freeze(entry))),
    omitted: Object.freeze(omitted.sort((a, b) => a.index - b.index).map((entry) => Object.freeze(entry))),
    changedPaths: Object.freeze(changedPaths.map((value) => String(value)))
  });

  return Object.freeze({ text: boundedText, manifest });
}
