import { createHash } from 'node:crypto';

import {
  AUDIT_RESERVED_SEMANTIC_CATEGORIES,
  AUDIT_SEMANTIC_CATEGORY_ORDER,
  auditSemanticCategory,
  isGeneratedLowValueAuditPath
} from './audit-context-policy.mjs';

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

const RESERVED_SEMANTIC_CATEGORY_SET = new Set(AUDIT_RESERVED_SEMANTIC_CATEGORIES);

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

function decodeGitQuotedPath(raw) {
  const text = String(raw ?? '');
  if (!text.startsWith('"')) return null;
  const bytes = [];
  const simpleEscapes = Object.freeze({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') return Buffer.from(bytes).toString('utf8');
    if (character !== '\\') {
      bytes.push(...Buffer.from(character, 'utf8'));
      continue;
    }
    index += 1;
    if (index >= text.length) return null;
    const escape = text[index];
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escape)) {
      bytes.push(simpleEscapes[escape]);
      continue;
    }
    if (/[0-7]/.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && index + 1 < text.length && /[0-7]/.test(text[index + 1])) {
        octal += text[index + 1];
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    return null;
  }
  return null;
}

function decodeDiffPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/dev/null') return null;
  let decoded;
  if (raw.startsWith('"')) {
    decoded = decodeGitQuotedPath(raw);
    if (!decoded) return null;
  } else {
    decoded = raw.split('\t', 1)[0];
  }
  if (decoded.startsWith('a/') || decoded.startsWith('b/')) decoded = decoded.slice(2);
  return decoded || null;
}

function diffGitHeaderPath(lines) {
  const header = lines.find((candidate) => candidate.startsWith('diff --git '));
  if (!header) return null;
  const rawTokens = header.slice('diff --git '.length).match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  if (rawTokens.length !== 2) return null;
  return decodeDiffPath(rawTokens[1]) ?? decodeDiffPath(rawTokens[0]);
}

function diffBlockPath(block) {
  const lines = String(block ?? '').split('\n');
  for (const prefix of ['+++ ', '--- ']) {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (!line) continue;
    const parsed = decodeDiffPath(line.slice(prefix.length));
    if (parsed) return parsed;
  }
  return diffGitHeaderPath(lines);
}

function emptyCategoryBytes() {
  return Object.fromEntries(AUDIT_SEMANTIC_CATEGORY_ORDER.map((category) => [category, 0]));
}

function emptyCategoryReservations() {
  return Object.freeze(Object.fromEntries(AUDIT_SEMANTIC_CATEGORY_ORDER.map((category) => [category, Object.freeze({
    required: false,
    path: null,
    bytes: 0,
    included: false
  })])));
}

function blockedAlignmentResult({ text, blocks, normalizedChangedPaths, parsedBlockPaths, resolvedLimits }) {
  const changedPathSet = new Set(normalizedChangedPaths);
  const omitted = blocks.map((block, index) => {
    const parsedPath = parsedBlockPaths[index] ?? null;
    const path = parsedPath && changedPathSet.has(parsedPath) ? parsedPath : null;
    return Object.freeze({
      index,
      path,
      parsedPath,
      bytes: Buffer.byteLength(block, 'utf8'),
      sha256: sha256(block),
      category: path ? auditSemanticCategory(path) : 'other',
      reason: 'unverified-path-alignment'
    });
  });
  const preflightReasons = Object.freeze(['path-alignment-unproven']);
  const manifest = Object.freeze({
    schemaVersion: 5,
    strategy: 'bounded-unified-diff-preflight-blocked',
    limits: resolvedLimits,
    contextReady: false,
    preflightReasons,
    categoryReservations: emptyCategoryReservations(),
    categoryBytes: Object.freeze(emptyCategoryBytes()),
    requiredReservationCount: 0,
    requiredReservationBytes: 0,
    reservationCoverageComplete: false,
    reservationFailureReasons: preflightReasons,
    fullDiffBytes: Buffer.byteLength(text, 'utf8'),
    fullDiffSha256: sha256(text),
    changedPathCount: normalizedChangedPaths.length,
    blockCount: blocks.length,
    alignmentExact: false,
    boundedBytes: 0,
    included: Object.freeze([]),
    omitted: Object.freeze(omitted),
    changedPaths: Object.freeze(normalizedChangedPaths)
  });
  return Object.freeze({ text: '', manifest });
}

export function boundAuditDiff(diffText, changedPaths, { limits } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');
  const text = String(diffText ?? '');
  const resolvedLimits = normalizeLimits(limits);
  const blocks = splitDiffBlocks(text);
  const normalizedChangedPaths = changedPaths.map((value) => String(value).trim()).filter(Boolean);
  if (normalizedChangedPaths.length === 0) throw new Error('changedPaths must contain at least one non-empty path');
  const changedPathSet = new Set(normalizedChangedPaths);
  const parsedBlockPaths = blocks.map(diffBlockPath);
  const parsedPathSet = new Set(parsedBlockPaths.filter(Boolean));
  const alignmentExact = blocks.length === normalizedChangedPaths.length
    && changedPathSet.size === normalizedChangedPaths.length
    && parsedBlockPaths.every(Boolean)
    && parsedPathSet.size === parsedBlockPaths.length
    && parsedPathSet.size === changedPathSet.size
    && parsedBlockPaths.every((filePath) => changedPathSet.has(filePath));
  if (!alignmentExact) return blockedAlignmentResult({ text, blocks, normalizedChangedPaths, parsedBlockPaths, resolvedLimits });

  const entries = blocks.map((block, index) => {
    const path = parsedBlockPaths[index];
    return {
      index,
      path,
      block,
      bytes: Buffer.byteLength(block, 'utf8'),
      sha256: sha256(block),
      category: auditSemanticCategory(path)
    };
  });

  const included = [];
  const omitted = [];
  const includedIndexes = new Set();
  let totalBytes = 0;
  const categoryBytes = emptyCategoryBytes();

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

  function resetIncluded() {
    included.length = 0;
    includedIndexes.clear();
    totalBytes = 0;
    for (const category of AUDIT_SEMANTIC_CATEGORY_ORDER) categoryBytes[category] = 0;
  }

  const materialEntries = [];
  const eligible = [];
  for (const entry of entries) {
    if (isGeneratedLowValueAuditPath(entry.path)) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason: 'generated-low-value' });
      continue;
    }
    materialEntries.push(entry);
    if (entry.bytes > resolvedLimits.maxFileBytes) {
      omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason: 'max-file-bytes' });
      continue;
    }
    eligible.push(entry);
  }

  const reservationCandidates = new Map();
  const requiredReservationCategories = new Set();
  const reservationFailureReasons = [];
  for (const category of AUDIT_RESERVED_SEMANTIC_CATEGORIES) {
    const materialCandidates = materialEntries.filter((entry) => entry.category === category);
    if (materialCandidates.length === 0) continue;
    requiredReservationCategories.add(category);
    const candidates = eligible
      .filter((entry) => entry.category === category)
      .sort((a, b) => a.bytes - b.bytes || a.index - b.index);
    if (candidates.length > 0) reservationCandidates.set(category, candidates[0]);
    else reservationFailureReasons.push(`required-category-no-eligible-representative:${category}`);
  }

  const requiredRepresentatives = AUDIT_RESERVED_SEMANTIC_CATEGORIES
    .map((category) => reservationCandidates.get(category))
    .filter(Boolean);
  const requiredReservationBytes = requiredRepresentatives.reduce((sum, entry) => sum + entry.bytes, 0);
  const requiredReservationCount = requiredReservationCategories.size;
  if (requiredReservationCount > resolvedLimits.maxFiles) reservationFailureReasons.push('required-reservation-file-limit-exceeded');
  if (requiredReservationBytes > resolvedLimits.maxTotalBytes) reservationFailureReasons.push('required-reservation-byte-limit-exceeded');

  if (reservationFailureReasons.length === 0) {
    for (const representative of requiredRepresentatives) {
      if (!include(representative)) reservationFailureReasons.push(`required-reservation-not-included:${representative.category}`);
    }
  }

  let reservationCoverageComplete = reservationFailureReasons.length === 0
    && [...requiredReservationCategories].every((category) => {
      const representative = reservationCandidates.get(category);
      return Boolean(representative && includedIndexes.has(representative.index));
    });
  if (!reservationCoverageComplete && reservationFailureReasons.length === 0) {
    reservationFailureReasons.push('semantic-reservation-incomplete');
    reservationCoverageComplete = false;
  }
  if (!reservationCoverageComplete) resetIncluded();

  if (reservationCoverageComplete) {
    const spillover = eligible
      .filter((entry) => !includedIndexes.has(entry.index))
      .sort((a, b) => AUDIT_SEMANTIC_CATEGORY_ORDER.indexOf(a.category) - AUDIT_SEMANTIC_CATEGORY_ORDER.indexOf(b.category) || a.index - b.index);
    for (const entry of spillover) include(entry);
  }

  for (const entry of eligible) {
    if (includedIndexes.has(entry.index)) continue;
    const reason = reservationCoverageComplete
      ? (included.length >= resolvedLimits.maxFiles ? 'max-files' : 'max-total-bytes')
      : 'semantic-reservation-incomplete';
    omitted.push({ index: entry.index, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, category: entry.category, reason });
  }

  const orderedIncluded = [...included].sort((a, b) => a.index - b.index);
  const categoryReservations = Object.freeze(Object.fromEntries(AUDIT_SEMANTIC_CATEGORY_ORDER.map((category) => {
    const representative = reservationCandidates.get(category);
    return [category, Object.freeze({
      required: RESERVED_SEMANTIC_CATEGORY_SET.has(category) && requiredReservationCategories.has(category),
      path: representative?.path ?? null,
      bytes: representative?.bytes ?? 0,
      included: Boolean(representative && includedIndexes.has(representative.index))
    })];
  })));
  const boundedText = orderedIncluded.map((entry) => entry.block).join('');
  const preflightReasons = Object.freeze([...reservationFailureReasons]);
  const contextReady = alignmentExact && reservationCoverageComplete && preflightReasons.length === 0;
  const manifest = Object.freeze({
    schemaVersion: 5,
    strategy: contextReady
      ? 'bounded-semantic-class-representative-unified-diff'
      : 'bounded-semantic-class-preflight-blocked',
    limits: resolvedLimits,
    contextReady,
    preflightReasons,
    categoryReservations,
    categoryBytes: Object.freeze(categoryBytes),
    requiredReservationCount,
    requiredReservationBytes,
    reservationCoverageComplete,
    reservationFailureReasons: preflightReasons,
    fullDiffBytes: Buffer.byteLength(text, 'utf8'),
    fullDiffSha256: sha256(text),
    changedPathCount: normalizedChangedPaths.length,
    blockCount: blocks.length,
    alignmentExact: true,
    boundedBytes: totalBytes,
    included: Object.freeze(orderedIncluded.map(({ block, ...entry }) => Object.freeze(entry))),
    omitted: Object.freeze(omitted.sort((a, b) => a.index - b.index).map((entry) => Object.freeze(entry))),
    changedPaths: Object.freeze(normalizedChangedPaths)
  });

  return Object.freeze({ text: boundedText, manifest });
}
