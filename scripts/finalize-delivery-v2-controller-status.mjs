#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

export function terminalReleaseStatusForControllerResult(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return null;
  if (String(payload.status ?? '') !== 'escalated') return null;
  const sha = String(payload.materialHeadSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('escalated controller result is missing exact materialHeadSha');
  const reason = String(payload.metrics?.terminalReason ?? payload.terminalReason ?? 'escalated').trim();
  return Object.freeze({ sha, state: 'failure', description: `Delivery V2 escalated: ${reason}`.slice(0, 140) });
}

async function main() {
  const resultPath = requiredString(process.env.CONTROLLER_RESULT_PATH, 'CONTROLLER_RESULT_PATH');
  let raw;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const payload = JSON.parse(raw);
  const terminal = terminalReleaseStatusForControllerResult(payload);
  if (!terminal) return;
  const repository = requiredString(process.env.TARGET_REPOSITORY, 'TARGET_REPOSITORY');
  const token = requiredString(process.env.DELIVERY_GITHUB_WRITE_TOKEN, 'DELIVERY_GITHUB_WRITE_TOKEN');
  const targetConfig = JSON.parse(await readFile(new URL('../config/delivery-v2-controller-targets.json', import.meta.url), 'utf8'));
  const context = requiredString(targetConfig.targets?.[repository]?.finalStatusName, 'configured finalStatusName');
  const targetUrl = `https://github.com/${requiredString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')}/actions/runs/${requiredString(process.env.GITHUB_RUN_ID, 'GITHUB_RUN_ID')}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/statuses/${terminal.sha}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'delivery-v2-terminal-status'
    },
    body: JSON.stringify({ state: terminal.state, context, description: terminal.description, target_url: targetUrl })
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} while publishing terminal release status: ${await response.text()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
