import { createHash } from 'node:crypto';

export const DEFAULT_AUDIT_DIFF_LIMITS = Object.freeze({
  maxFiles: 24,
  maxFileBytes: 16 * 1024,
  maxTotalBytes: 64 * 1024
});

export const STANDARD_AUDIT_DIFF_LIMITS = Object.freeze({
  maxFiles: 12,
  maxFileBytes: 12 * 1024,
  maxTotalBytes: 32 * 1024
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

function pathPriority(filePath) {
  const value = String(filePath ?? '');
  if (/^(?:src|scripts|actions|config|schemas)\//.test(value) || /^\.github\/(?:scripts|workflows)\//.test(value)) return 0;
  if (/^(?:test|tests|__tests__)\//.test(value) || /(?:^|\/)test\./.test(value)) return 1;
  if (/^(?:docs|README)/.test(value)) return 2;
  return 3;
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
    sha256: sha256(block)
  }));
  const ordered = alignmentExact
    ? [...entries].sort((a, b) => pathPriority(a.path) - pathPriority(b.path) || a.index - b.index)
    : entries;

  const included = [];
  const omitted = [];
  let totalBytes = 0;

  for (const entry of ordered) {
    if (entry.bytes > resolvedLimits.maxFileBytes) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, reason: 'max-file-bytes' });
      continue;
    }
    if (included.length >= resolvedLimits.maxFiles) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, reason: 'max-files' });
      continue;
    }
    if (totalBytes + entry.bytes > resolvedLimits.maxTotalBytes) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, reason: 'max-total-bytes' });
      continue;
    }
    included.push(entry);
    totalBytes += entry.bytes;
  }

  const boundedText = included.map((entry) => entry.block).join('');
  const manifest = Object.freeze({
    schemaVersion: 1,
    strategy: 'bounded-prioritized-unified-diff',
    limits: resolvedLimits,
    fullDiffBytes: Buffer.byteLength(text, 'utf8'),
    fullDiffSha256: sha256(text),
    changedPathCount: changedPaths.length,
    blockCount: blocks.length,
    alignmentExact,
    boundedBytes: totalBytes,
    included: Object.freeze(included.map(({ block, ...entry }) => Object.freeze(entry))),
    omitted: Object.freeze(omitted.map((entry) => Object.freeze(entry))),
    changedPaths: Object.freeze(changedPaths.map((value) => String(value)))
  });

  return Object.freeze({ text: boundedText, manifest });
}
