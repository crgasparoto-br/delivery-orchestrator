#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeGhAwUsage, parseGhAwUsageJsonl } from '../src/v2/usage-telemetry.mjs';

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') result.json = argv[++i];
    else if (argv[i] === '--jsonl') result.jsonl = argv[++i];
    else if (argv[i] === '--out') result.out = argv[++i];
  }
  return result;
}

const input = args(process.argv.slice(2));
if (!input.json && !input.jsonl) throw new Error('provide --json or --jsonl');
let usage;
if (input.json) usage = normalizeGhAwUsage(JSON.parse(await readFile(path.resolve(input.json), 'utf8')));
else usage = parseGhAwUsageJsonl(await readFile(path.resolve(input.jsonl), 'utf8'));
const result = { schemaVersion: 1, kind: 'delivery-v2-gh-aw-usage', usage };
const body = `${JSON.stringify(result, null, 2)}\n`;
if (input.out) await writeFile(path.resolve(input.out), body, 'utf8');
else process.stdout.write(body);
