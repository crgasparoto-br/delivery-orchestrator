#!/usr/bin/env node
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { CodexExecutor } from './codex-executor.mjs';
import { loadConfig } from './config.mjs';
import { writeJson } from './files.mjs';
import { runDelivery } from './orchestrator.mjs';
import { finalizeIndependentRelease } from './release-finalizer.mjs';
import { verifySynchronizedSkillCatalog } from './skill-catalog-sync.mjs';

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
  const synchronizedCatalog = await verifySynchronizedSkillCatalog(root);
  const required = [
    'prompts/implementer.md', 'prompts/auditor.md',
    'skills/catalog/entregar-issue/SKILL.md', 'skills/catalog/auditar-issue/SKILL.md',
    'src/role-runtime-worker.mjs', 'src/pr-release-signal.mjs', 'src/release-finalizer.mjs'
  ];
  for (const rel of required) await access(path.join(root, rel));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!pkg.dependencies?.['@openai/codex-sdk']) throw new Error('Missing @openai/codex-sdk dependency');
  console.log(JSON.stringify({ ok: true, synchronizedCatalog, required }, null, 2));
}

const [command = 'run', ...rest] = process.argv.slice(2);
if (command === 'validate') await validate();
else if (command === 'run') {
  const config = loadConfig(parseArgs(rest));
  const executor = new CodexExecutor({
    apiKey: config.openaiApiKey,
    authMode: config.authMode,
    model: config.model,
    implementerUser: config.implementerUser,
    auditorUser: config.auditorUser
  });
  let state = await runDelivery(config, executor);
  state = await finalizeIndependentRelease({ state, config });
  await writeJson(path.join(config.runsRoot, state.run_id, 'state.json'), state);
  console.log(JSON.stringify(state, null, 2));
  if (state.status !== 'COMPLETE') process.exitCode = 2;
} else throw new Error(`Unknown command: ${command}`);
