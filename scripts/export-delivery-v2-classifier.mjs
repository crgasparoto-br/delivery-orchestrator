#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildClassifierPackage } from '../src/v2/classifier-distribution.mjs';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--target-config') out.targetConfig = argv[++index];
    else if (token === '--source-commit') out.sourceCommit = argv[++index];
    else if (token === '--out') out.out = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!out.targetConfig) throw new Error('--target-config is required');
  if (!out.sourceCommit) throw new Error('--source-commit is required');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const targetConfig = JSON.parse(readFileSync(resolve(args.targetConfig), 'utf8'));
const bundle = buildClassifierPackage({ sourceCommit: args.sourceCommit, targetConfig });
const outputDir = resolve(args.out || bundle.target.packageDir);
for (const [path, content] of Object.entries(bundle.files)) {
  const absolute = resolve(outputDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
process.stdout.write(`${JSON.stringify({
  repository: bundle.target.repository,
  outputDir,
  packageFingerprint: bundle.lock.packageFingerprint,
  sourceCommit: bundle.lock.source.commit,
  verificationCommand: bundle.lock.verificationCommand
}, null, 2)}\n`);
