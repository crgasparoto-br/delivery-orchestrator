#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { originIssueStatus } from '../src/v2/controller-continuity.mjs';
import { githubApi } from '../src/v2/controller-github-api.mjs';

const MARKER = '<!-- delivery-v2-origin-status -->';

function requiredString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}
function positiveInteger(value, label) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
}
export async function main() {
  const repository = requiredString(process.env.TARGET_REPOSITORY, 'TARGET_REPOSITORY');
  const issueNumber = positiveInteger(process.env.TARGET_ISSUE, 'TARGET_ISSUE');
  const token = requiredString(process.env.DELIVERY_GITHUB_WRITE_TOKEN, 'DELIVERY_GITHUB_WRITE_TOKEN');
  const controllerOutcome = String(process.env.DELIVERY_V2_CONTROLLER_OUTCOME ?? '').trim();
  const continuationScheduled = String(process.env.DELIVERY_V2_CONTINUATION_SCHEDULED ?? '').trim() === 'true';
  const runUrl = `https://github.com/${requiredString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')}/actions/runs/${requiredString(process.env.GITHUB_RUN_ID, 'GITHUB_RUN_ID')}`;

  let result = null;
  const resultPath = String(process.env.CONTROLLER_RESULT_PATH ?? '').trim();
  if (resultPath) {
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const deliveryStatus = originIssueStatus({ result, controllerOutcome, continuationScheduled, runUrl });
  const body = `${MARKER}
## Delivery V2 status

${deliveryStatus.body}

Estado: **${deliveryStatus.state}**`;
  const comments = await githubApi(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100`, token, { userAgent: 'delivery-v2-origin-status' });
  const existing = comments.find((comment) => String(comment.body ?? '').includes(MARKER));
  if (existing) {
    await githubApi(`https://api.github.com/repos/${repository}/issues/comments/${existing.id}`, token, {
      userAgent: 'delivery-v2-origin-status',
      method: 'PATCH',
      body: JSON.stringify({ body })
    });
  } else {
    await githubApi(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, token, {
      userAgent: 'delivery-v2-origin-status',
      method: 'POST',
      body: JSON.stringify({ body })
    });
  }
  process.stdout.write(`[delivery-v2] origin issue status updated issue=${issueNumber} state=${deliveryStatus.state}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
