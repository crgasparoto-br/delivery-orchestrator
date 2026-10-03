import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function changedPathsFromGitPatch(patchPath, {
  inspectPatch = (file) => execFileSync('git', ['apply', '--numstat', '-z', file])
} = {}) {
  const output = inspectPatch(patchPath);
  const fields = Buffer.isBuffer(output) ? output.toString('utf8').split('\0') : String(output).split('\0');
  const paths = [];
  for (const field of fields) {
    if (!field) continue;
    const columns = field.split('\t');
    if (columns.length !== 3 || !columns[2]) throw new Error('candidate patch numstat is malformed');
    paths.push(columns[2]);
  }
  return [...new Set(paths)].sort();
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
    const artifacts = payload.artifacts ?? [];
    const artifact = artifacts.find((item) => item.name === 'agent')
      ?? artifacts.find((item) => item.name === 'agent-output-fallback');

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
      let agentOutputPath = null;
      const patchPaths = [];

      while (stack.length) {
        const current = stack.pop();
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name === 'agent_output.json') agentOutputPath = full;
          else if (/^aw-.*\.patch$/.test(entry.name)) patchPaths.push(full);
        }
      }

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
          ? [...new Set(patchPaths.flatMap((patchPath) => changedPathsFromGitPatch(patchPath)))].sort()
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
