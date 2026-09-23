import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeGhAwUsage, parseGhAwUsageJsonl } from './usage-telemetry.mjs';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-usage-artifact'
  };
}

export async function downloadGhAwUsageArtifact({ repository, runId, token } = {}) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, { headers: headers(token) });
    if (!response.ok) throw new Error(`usage artifact listing failed: ${response.status}`);
    const payload = await response.json();
    const artifact = (payload.artifacts ?? []).find((item) => item.name === 'usage');
    if (!artifact) return { usage: normalizeGhAwUsage({}), rawUsagePayload: null, evidenceRef: null };
    const download = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, { headers: headers(token) });
    if (!download.ok) throw new Error(`usage artifact download failed: ${download.status}`);
    const root = await mkdtemp(path.join(tmpdir(), 'dv2-usage-'));
    try {
      const zip = path.join(root, 'usage.zip');
      await writeFile(zip, Buffer.from(await download.arrayBuffer()));
      execFileSync('unzip', ['-q', zip, '-d', root]);
      const stack = [root];
      let json = null;
      let jsonl = null;
      while (stack.length) {
        const current = stack.pop();
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name === 'agent_usage.json') json = full;
          else if (entry.name === 'agent_usage.jsonl') jsonl = full;
        }
      }
      // The raw payload is returned alongside the normalized counters so the observability
      // accumulator can attribute model / reported cost / run timestamps / cache counters from
      // the same artifact instead of discarding that evidence here.
      let usage = normalizeGhAwUsage({});
      let rawUsagePayload = null;
      if (json) {
        rawUsagePayload = JSON.parse(await readFile(json, 'utf8'));
        usage = normalizeGhAwUsage(rawUsagePayload);
      } else if (jsonl) {
        const text = await readFile(jsonl, 'utf8');
        rawUsagePayload = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
        usage = parseGhAwUsageJsonl(text);
      }
      return { usage, rawUsagePayload, evidenceRef: artifact.archive_download_url, artifactId: artifact.id };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } catch (error) {
    return { usage: normalizeGhAwUsage({}), rawUsagePayload: null, evidenceRef: null, error: error.message };
  }
}
