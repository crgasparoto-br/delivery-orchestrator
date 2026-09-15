import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateTechnicalHygiene } from './technical-hygiene.mjs';

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
    const summary = summaryFromAgentLog(await readFile(log, 'utf8'));
    return evaluateTechnicalHygiene({
      schemaVersion: 1,
      profile,
      baselineSha,
      materialSha,
      previousMaterialSha,
      reuseDiscovery: summary.reuseDiscovery ?? [],
      structuralFindings: summary.structuralFindings ?? [],
      semanticJudgments: summary.semanticJudgments ?? [],
      deterministicReferences: summary.deterministicReferences ?? [],
      missingEvidence: summary.missingEvidence ?? [],
      semanticCalls: summary.semanticCalls ?? 0,
      evidenceRef: artifact.archive_download_url
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const __test = Object.freeze({ summaryFromAgentLog });
