import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateTechnicalHygiene } from './technical-hygiene.mjs';

const REUSE_DECISIONS = new Set(['REUSE_EXISTING', 'EXTEND_EXISTING', 'LOCAL_REFACTOR', 'CREATE_NEW', 'KEEP_SEPARATE', 'UNKNOWN']);

function headers(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'delivery-v2-hygiene-artifact' };
}

function summaryFromAgentLog(rawLog) {
  const marker = 'TECHNICAL_HYGIENE_JSON=';
  const messages = [];
  for (const line of String(rawLog ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'item.completed' && entry?.item?.type === 'agent_message') messages.push(String(entry.item.text ?? ''));
    } catch {}
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index];
    const at = text.lastIndexOf(marker);
    if (at < 0) continue;
    const payload = text.slice(at + marker.length).split(/\r?\n/, 1)[0].trim();
    const parsed = JSON.parse(payload);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('technical hygiene worker summary must be an object');
    return parsed;
  }
  throw new Error('worker artifact is missing TECHNICAL_HYGIENE_JSON summary');
}

function nonEmptyStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function normalizeEvidenceList(value, label) {
  if (value == null) return [];

  if (typeof value === 'string') {
    const resolved = value.trim();
    return resolved ? [resolved] : [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of evidence strings`);
  }

  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function normalizeWorkerSummary(rawSummary) {
  const summary = rawSummary && !Array.isArray(rawSummary) && typeof rawSummary === 'object' ? rawSummary : null;
  if (!summary) throw new Error('technical hygiene worker summary must be an object');

  const shorthandEvidence = nonEmptyStrings(summary.deterministicReferences);
  let reuseDiscovery = summary.reuseDiscovery ?? [];
  if (typeof reuseDiscovery === 'string') {
    const decision = reuseDiscovery.trim().toUpperCase();
    if (!REUSE_DECISIONS.has(decision)) throw new Error(`unsupported shorthand reuse decision: ${decision}`);
    if (shorthandEvidence.length === 0) throw new Error('shorthand reuseDiscovery requires deterministicReferences evidence');
    reuseDiscovery = [{ symbol: 'worker-scope', decision, evidence: shorthandEvidence }];
  }
  if (!Array.isArray(reuseDiscovery)) throw new Error('reuseDiscovery must be an array or a supported shorthand decision');

  reuseDiscovery = reuseDiscovery.map((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
      throw new Error(`reuseDiscovery[${index}] must be an object`);
    }

    const normalized = {
      ...entry,
      evidence: normalizeEvidenceList(
        entry.evidence,
        `reuseDiscovery[${index}].evidence`
      )
    };

    if (entry.existingOwnerEvidence != null) {
      normalized.existingOwnerEvidence = normalizeEvidenceList(
        entry.existingOwnerEvidence,
        `reuseDiscovery[${index}].existingOwnerEvidence`
      );
    }

    if (entry.justificationEvidence != null) {
      normalized.justificationEvidence = normalizeEvidenceList(
        entry.justificationEvidence,
        `reuseDiscovery[${index}].justificationEvidence`
      );
    }

    return normalized;
  });

  const compatibilityMissingEvidence = [];

  let structuralFindings = summary.structuralFindings ?? [];
  if (!Array.isArray(structuralFindings)) {
    throw new Error('structuralFindings must be an array');
  }

  structuralFindings = structuralFindings.flatMap((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
      compatibilityMissingEvidence.push({
        code: 'MALFORMED_STRUCTURAL_FINDING',
        detail: `structuralFindings[${index}] must be a canonical object`,
        material: true
      });
      return [];
    }

    const kind = String(entry.kind ?? '').trim();

    if (!kind) {
      const claim = String(entry.claim ?? '').trim();

      compatibilityMissingEvidence.push({
        code: 'MALFORMED_STRUCTURAL_FINDING',
        detail:
          `structuralFindings[${index}] is missing canonical kind` +
          (claim ? `; worker claim: ${claim}` : ''),
        material: true
      });

      return [];
    }

    return [{
      ...entry,
      kind,
      evidence: normalizeEvidenceList(
        entry.evidence,
        `structuralFindings[${index}].evidence`
      ),
      rootCauseEvidence: normalizeEvidenceList(
        entry.rootCauseEvidence,
        `structuralFindings[${index}].rootCauseEvidence`
      )
    }];
  });

  let semanticJudgments = summary.semanticJudgments ?? [];
  if (!Array.isArray(semanticJudgments)) throw new Error('semanticJudgments must be an array');
  semanticJudgments = semanticJudgments.map((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error(`semanticJudgments[${index}] must be an object`);

    const evidence = normalizeEvidenceList(
      entry.evidence,
      `semanticJudgments[${index}].evidence`
    );

    if (String(entry.claim ?? '').trim()) {
      return { ...entry, evidence };
    }

    const decision = String(entry.decision ?? '').trim();
    if (!decision) throw new Error(`semanticJudgments[${index}] requires claim or decision`);

    return { ...entry, claim: decision, evidence };
  });

  let deterministicReferences = summary.deterministicReferences ?? [];
  if (!Array.isArray(deterministicReferences)) throw new Error('deterministicReferences must be an array');
  deterministicReferences = deterministicReferences.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) {
      const evidenceRef = entry.trim();
      return { symbol: evidenceRef, referenced: true, evidence: [evidenceRef] };
    }
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error(`deterministicReferences[${index}] must be an object or evidence string`);

    return {
      ...entry,
      evidence: normalizeEvidenceList(
        entry.evidence,
        `deterministicReferences[${index}].evidence`
      )
    };
  });

  let missingEvidence = summary.missingEvidence ?? [];
  if (!Array.isArray(missingEvidence)) {
    throw new Error('missingEvidence must be an array');
  }

  missingEvidence = missingEvidence.map((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
      throw new Error(`missingEvidence[${index}] must be an object`);
    }
    return entry;
  });

  let semanticCalls = summary.semanticCalls ?? 0;
  if (Array.isArray(semanticCalls)) semanticCalls = semanticCalls.length;
  if (!Number.isInteger(semanticCalls) || semanticCalls < 0) throw new Error('semanticCalls must be a non-negative integer or an array of semantic-call descriptions');

  return {
    ...summary,
    reuseDiscovery,
    structuralFindings,
    semanticJudgments,
    deterministicReferences,
    missingEvidence: [
      ...missingEvidence,
      ...compatibilityMissingEvidence
    ],
    semanticCalls
  };
}


function evaluateWorkerSummaryFailClosed({
  rawSummary,
  profile,
  baselineSha,
  materialSha,
  previousMaterialSha = null,
  evidenceRef
} = {}) {
  const trustedInput = {
    schemaVersion: 1,
    profile,
    baselineSha,
    materialSha,
    previousMaterialSha,
    evidenceRef
  };

  try {
    const summary = normalizeWorkerSummary(rawSummary);

    return evaluateTechnicalHygiene({
      ...trustedInput,
      reuseDiscovery: summary.reuseDiscovery ?? [],
      createdFiles: summary.createdFiles ?? [],
      structuralFindings: summary.structuralFindings ?? [],
      semanticJudgments: summary.semanticJudgments ?? [],
      deterministicReferences: summary.deterministicReferences ?? [],
      missingEvidence: summary.missingEvidence ?? [],
      semanticCalls: summary.semanticCalls ?? 0
    });
  } catch (error) {
    return evaluateTechnicalHygiene({
      ...trustedInput,
      reuseDiscovery: [],
      createdFiles: [],
      structuralFindings: [],
      semanticJudgments: [],
      deterministicReferences: [],
      missingEvidence: [
        {
          code: 'MALFORMED_WORKER_ARTIFACT',
          detail:
            `technical hygiene worker payload rejected: ${
              String(error?.message ?? error)
            }`,
          material: true
        }
      ],
      semanticCalls: 0
    });
  }
}

async function findFile(root, expected) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === expected) return full;
    }
  }
  return null;
}

export async function downloadGhAwTechnicalHygieneArtifact({ repository, runId, token, baselineSha, materialSha, previousMaterialSha = null, profile } = {}) {
  const list = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, { headers: headers(token) });
  if (!list.ok) throw new Error(`hygiene artifact listing failed: ${list.status}`);
  const payload = await list.json();
  const artifact = (payload.artifacts ?? []).find((item) => item.name === 'agent');
  if (!artifact) throw new Error('worker agent artifact is missing');
  const download = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, { headers: headers(token) });
  if (!download.ok) throw new Error(`hygiene artifact download failed: ${download.status}`);
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-hygiene-'));
  try {
    const zip = path.join(root, 'agent.zip');
    await writeFile(zip, Buffer.from(await download.arrayBuffer()));
    execFileSync('unzip', ['-q', zip, '-d', root]);
    const log = await findFile(root, 'agent-stdio.log');
    if (!log) throw new Error('worker agent artifact is missing agent-stdio.log');
    let rawSummary;

    try {
      rawSummary = summaryFromAgentLog(await readFile(log, 'utf8'));
    } catch (error) {
      return evaluateWorkerSummaryFailClosed({
        rawSummary: {
          reuseDiscovery: [],
          createdFiles: [],
          structuralFindings: [],
          semanticJudgments: [],
          deterministicReferences: [],
          missingEvidence: [
            {
              code: 'MALFORMED_WORKER_ARTIFACT',
              detail:
                `technical hygiene worker marker rejected: ${
                  String(error?.message ?? error)
                }`,
              material: true
            }
          ],
          semanticCalls: 0
        },
        profile,
        baselineSha,
        materialSha,
        previousMaterialSha,
        evidenceRef: artifact.archive_download_url
      });
    }

    return evaluateWorkerSummaryFailClosed({
      rawSummary,
      profile,
      baselineSha,
      materialSha,
      previousMaterialSha,
      evidenceRef: artifact.archive_download_url
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const __test = Object.freeze({
  summaryFromAgentLog,
  normalizeWorkerSummary,
  evaluateWorkerSummaryFailClosed
});
