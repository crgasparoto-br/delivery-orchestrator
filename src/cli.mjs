#!/usr/bin/env node
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { CodexExecutor } from './codex-executor.mjs';
import { loadConfig } from './config.mjs';
import { runDelivery } from './orchestrator.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repository = argv[++i];
    else if (argv[i] === '--issue') out.issueNumber = argv[++i];
  }
  return out;
}

async function validate() {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const required = [
    'prompts/implementer.md', 'prompts/auditor.md',
    'skills/catalog/entregar-issue/SKILL.md', 'skills/catalog/auditar-issue/SKILL.md'
  ];
  for (const rel of required) await access(path.join(root, rel));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!pkg.dependencies?.['@openai/codex-sdk']) throw new Error('Missing @openai/codex-sdk dependency');
  console.log(JSON.stringify({ ok: true, required }, null, 2));
}

const [command = 'run', ...rest] = process.argv.slice(2);
if (command === 'validate') {
  await validate();
} else if (command === 'run') {
  const config = loadConfig(parseArgs(rest));
  const executor = new CodexExecutor({ apiKey: config.openaiApiKey, model: config.model });
  const state = await runDelivery(config, executor);
  console.log(JSON.stringify(state, null, 2));
  if (state.status !== 'COMPLETE') process.exitCode = 2;
} else {
  throw new Error(`Unknown command: ${command}`);
}
