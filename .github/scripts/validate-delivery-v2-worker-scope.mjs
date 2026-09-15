#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseTrustedMarkerEnvelope } from './validate-delivery-v2-worker-authorization.mjs';
import {
  assertChangedPathsAuthorized,
  createWorkerScopeBinding,
  normalizeScopePath,
  validateWorkerScopeBinding
} from './delivery-v2-worker-scope-contract.mjs';

const BOOTSTRAP_MARKER = '<!-- delivery-v2-bootstrap-state -->';

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function requiredPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requiredString(token, 'token')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'delivery-v2-worker-scope-validator'
  };
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} GET ${url}: ${await response.text()}`);
  return response.json();
}

async function listComments(repository, issueNumber, token) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`, token);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function legacyRemediationBinding({ repository, issue, pullRequestNumber, token }) {
  const paths = [];
  for (let page = 1; ; page += 1) {
    const files = await fetchJson(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, token);
    paths.push(...files.map((file) => file.filename));
    if (files.length < 100) break;
  }
  if (!paths.length) throw new Error('legacy remediation scope cannot be derived from an empty PR');
  return createWorkerScopeBinding({ repository, issue, authorizedPaths: paths });
}

function pathsFromNumstatBuffer(buffer) {
  const result = [];
  for (const record of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const fields = record.split('\t');
    if (fields.length < 3) throw new Error(`unexpected git apply --numstat record: ${record}`);
    result.push(normalizeScopePath(fields.slice(2).join('\t')));
  }
  return result;
}

export async function changedPathsFromPatchFile(patchPath) {
  const patch = await readFile(patchPath, 'utf8');
  if (!patch.trim()) throw new Error('candidate patch is empty');
  let numstat;
  try {
    numstat = execFileSync('git', ['apply', '--numstat', '-z', patchPath], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`candidate patch cannot be parsed safely: ${error.stderr?.toString('utf8') || error.message}`);
  }
  const result = new Set(pathsFromNumstatBuffer(numstat));
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^(?:rename|copy) from (.+)$/);
    if (match) result.add(normalizeScopePath(match[1]));
  }
  if (!result.size) throw new Error('candidate patch has no material paths');
  return [...result].sort();
}

export async function main() {
  const repository = requiredString(process.env.TARGET_REPOSITORY, 'TARGET_REPOSITORY');
  const issueNumber = requiredPositiveInteger(process.env.TARGET_ISSUE, 'TARGET_ISSUE');
  const targetPr = String(process.env.TARGET_PR ?? '').trim();
  const controllerRunId = requiredPositiveInteger(process.env.CONTROLLER_RUN_ID, 'CONTROLLER_RUN_ID');
  const dispatchNonce = requiredString(process.env.DISPATCH_NONCE, 'DISPATCH_NONCE');
  const token = requiredString(process.env.DELIVERY_GITHUB_READ_TOKEN, 'DELIVERY_GITHUB_READ_TOKEN');
  const patchPath = requiredString(process.env.PATCH_PATH || '/tmp/gh-aw/threat-detection/aw.patch', 'PATCH_PATH');

  const issue = await fetchJson(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, token);
  const comments = await listComments(repository, issueNumber, token);
  const bootstrap = parseTrustedMarkerEnvelope(comments, {
    marker: BOOTSTRAP_MARKER,
    label: 'Delivery V2 bootstrap state',
    repository
  });

  let binding = bootstrap?.scopeBinding ?? null;
  let source = 'bootstrap';
  if (!targetPr) {
    if (!bootstrap) throw new Error('trusted bootstrap scope authorization is required before initial safe outputs');
    if (Number(bootstrap.controllerRunId) !== controllerRunId) throw new Error('scope binding controller run mismatch');
    if (String(bootstrap.dispatchNonce ?? '') !== dispatchNonce) throw new Error('scope binding dispatch nonce mismatch');
    if (!binding) throw new Error('trusted bootstrap is missing scopeBinding');
  } else if (!binding) {
    binding = await legacyRemediationBinding({ repository, issue, pullRequestNumber: requiredPositiveInteger(targetPr, 'TARGET_PR'), token });
    source = 'legacy-pr-boundary';
  }

  const verified = validateWorkerScopeBinding(binding, { repository, issue });
  const changedPaths = await changedPathsFromPatchFile(patchPath);
  const result = assertChangedPathsAuthorized(changedPaths, verified);
  process.stdout.write(`${JSON.stringify({ authorized: true, source, enforcement: verified.enforcement, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
