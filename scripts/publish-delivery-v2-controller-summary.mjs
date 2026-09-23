#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  appendDeliveryControllerSummary,
  buildDeliveryControllerSummary,
  parseControllerTechnicalErrors
} from '../src/v2/controller-summary.mjs';

async function readOptional(filePath) {
  const target = String(filePath ?? '').trim();
  if (!target) return null;
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function collectDeliveryControllerSummaryInput(env = process.env, { read = readOptional } = {}) {
  const errors = parseControllerTechnicalErrors(await read(env.CONTROLLER_ERROR_PATH));
  let result = null;
  const raw = await read(env.CONTROLLER_RESULT_PATH);
  if (raw != null) {
    try {
      result = JSON.parse(raw);
    } catch (error) {
      errors.push({ source: 'controller-result', message: `resultado do controller ilegivel: ${error.message}` });
    }
  }
  const server = String(env.GITHUB_SERVER_URL ?? 'https://github.com').trim();
  const runUrl = env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  return {
    result,
    identity: {
      repository: env.TARGET_REPOSITORY,
      issueNumber: env.TARGET_ISSUE,
      baseBranch: env.BASE_BRANCH,
      runUrl
    },
    technical: {
      jobStatus: env.DELIVERY_V2_JOB_STATUS,
      guardOutcome: env.DELIVERY_V2_GUARD_OUTCOME,
      controllerOutcome: env.DELIVERY_V2_CONTROLLER_OUTCOME,
      errors
    }
  };
}

async function main() {
  const markdown = buildDeliveryControllerSummary(await collectDeliveryControllerSummaryInput());
  if (!await appendDeliveryControllerSummary(markdown)) process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
