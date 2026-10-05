import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materialPathsFromGitPatch } from '../../.github/scripts/delivery-v2-worker-scope-contract.mjs';

function inspectGitPatch(file) {
  const patch = readFileSync(file, 'utf8');
  if (!patch.trim()) throw new Error('candidate patch is empty');
  const numstat = execFileSync('git', ['apply', '--numstat', '-z', file], { maxBuffer: 16 * 1024 * 1024 });
  return { patch, numstat };
}

export function changedPathsFromGitPatch(patchPath, { inspectPatch = inspectGitPatch } = {}) {
  const inspection = inspectPatch(patchPath);
  // Preserve buffer-only injected inspectors; the real inspector always reads
  // both the patch headers and Git's NUL-delimited numstat from the same file.
  return materialPathsFromGitPatch(inspection.patch ?? '', inspection.numstat ?? inspection);
}

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-agent-output-artifact'
  };
}

async function api(url, token) {
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  }
  return response.json();
}

export async function downloadGhAwAgentOutputArtifact({
  repository,
  runId,
  token
} = {}) {
  try {
    const payload = await api(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
      token
    );
    const artifacts = payload.artifacts;
    if (!Array.isArray(artifacts) || Number(payload.total_count ?? artifacts.length) > artifacts.length) {
      throw new Error('complete agent artifact inventory is unavailable');
    }
    const primary = artifacts.filter((item) => item.name === 'agent');
    const candidates = primary.length ? primary : artifacts.filter((item) => item.name === 'agent-output-fallback');
    if (candidates.length > 1) throw new Error('agent output artifact is ambiguous');
    const artifact = candidates[0];
    if (artifact?.expired === true) throw new Error('agent output artifact is expired');

    if (!artifact) {
      return {
        hasPatch: null,
        agentOutput: null,
        evidenceRef: null,
        error: 'agent output artifact is unavailable'
      };
    }

    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
      { headers: headers(token) }
    );
    if (!response.ok) {
      throw new Error(`agent output artifact download failed: ${response.status}`);
    }

    const root = await mkdtemp(path.join(tmpdir(), 'dv2-agent-output-'));
    try {
      const zip = path.join(root, 'agent.zip');
      await writeFile(zip, Buffer.from(await response.arrayBuffer()));
      execFileSync('unzip', ['-q', zip, '-d', root]);

      const stack = [root];
      const agentOutputPaths = [];
      const patchPaths = [];

      while (stack.length) {
        const current = stack.pop();
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (!entry.isFile()) throw new Error('agent artifact contains a non-regular file');
          else if (entry.name === 'agent_output.json') agentOutputPaths.push(full);
          else if (entry.name.endsWith('.patch')) patchPaths.push(full);
        }
      }

      if (agentOutputPaths.length > 1) throw new Error('agent_output.json is ambiguous');
      if (artifact.name === 'agent' && patchPaths.length > 1) {
        throw new Error(`expected at most one candidate patch, found ${patchPaths.length}`);
      }
      if (artifact.name === 'agent' && patchPaths.length === 1 && !/^aw-.*\.patch$/.test(path.basename(patchPaths[0]))) {
        throw new Error('authoritative aw candidate patch is unavailable');
      }
      const agentOutputPath = agentOutputPaths[0];
      if (!agentOutputPath) {
        return {
          hasPatch: null,
          agentOutput: null,
          evidenceRef: artifact.archive_download_url,
          artifactId: artifact.id,
          error: 'agent_output.json is unavailable'
        };
      }

      return {
        hasPatch: artifact.name === 'agent' ? patchPaths.length > 0 : null,
        changedPaths: artifact.name === 'agent'
          ? (patchPaths.length ? changedPathsFromGitPatch(patchPaths[0]) : [])
          : null,
        agentOutput: JSON.parse(await readFile(agentOutputPath, 'utf8')),
        evidenceRef: artifact.archive_download_url,
        artifactId: artifact.id
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      hasPatch: null,
      agentOutput: null,
      evidenceRef: null,
      error: error.message
    };
  }
}
