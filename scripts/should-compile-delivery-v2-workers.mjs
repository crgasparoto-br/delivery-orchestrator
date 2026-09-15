#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const EXACT_IDENTITY_PATHS = new Set([
  '.github/aw/actions-lock.json',
  '.github/workflows/delivery-v2-ci.yml',
  '.github/workflows/delivery-v2-gh-aw-compile.yml',
  'scripts/should-compile-delivery-v2-workers.mjs'
]);
const WORKER_IDENTITY_PATH = /^\.github\/workflows\/delivery-v2-worker-[^/]+-[^/]+\.(?:md|lock\.yml)$/;
const SHARED_WORKER_IDENTITY_PATH = /^\.github\/workflows\/shared\/[^/]+\.md$/;

export function requiresWorkerCompilation(changedPaths) {
  if (!Array.isArray(changedPaths)) throw new Error('changedPaths must be an array');
  return changedPaths.some((value) => {
    const filePath = String(value ?? '').trim();
    return EXACT_IDENTITY_PATHS.has(filePath) || WORKER_IDENTITY_PATH.test(filePath) || SHARED_WORKER_IDENTITY_PATH.test(filePath);
  });
}

export async function main() {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  const changedPaths = body.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  process.stdout.write(`${requiresWorkerCompilation(changedPaths)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
