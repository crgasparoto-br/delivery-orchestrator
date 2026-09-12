#!/usr/bin/env node
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { loadV2Config } from './v2/config.mjs';
import { createDeliveryPlan } from './v2/delivery-plan.mjs';
import { resumePersistentDelivery } from './v2/persistent-state.mjs';
import { loadDeliveryMetricsStore, summarizeDeliveryMetrics } from './v2/metrics.mjs';

function parseArgs(argv) {
  const out = { changedPaths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repository = argv[++i];
    else if (argv[i] === '--issue') out.issueNumber = argv[++i];
    else if (argv[i] === '--provider') out.provider = argv[++i];
    else if (argv[i] === '--implementer-provider') out.implementerProvider = argv[++i];
    else if (argv[i] === '--auditor-provider') out.auditorProvider = argv[++i];
    else if (argv[i] === '--risk') out.risk = argv[++i];
    else if (argv[i] === '--state-file') out.stateFile = argv[++i];
    else if (argv[i] === '--pr') out.pullRequestNumber = argv[++i];
    else if (argv[i] === '--head-ref') out.headRef = argv[++i];
    else if (argv[i] === '--remote-head') out.remoteHeadSha = argv[++i];
    else if (argv[i] === '--metrics-file') out.metricsFile = argv[++i];
    else if (argv[i] === '--path') out.changedPaths.push(argv[++i]);
  }
  return out;
}

async function validate() {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const required = [
    'docs/delivery-v2/MASTER_SPEC.md',
    'docs/delivery-v2/ROADMAP.md',
    'config/delivery-v2-requirements.json',
    '.github/workflows/delivery-v2-dispatch.yml',
    '.github/workflows/delivery-v2-ci.yml',
    '.github/workflows/delivery-v2-independent-audit.yml',
    'src/v2/provider-policy.mjs',
    'src/v2/risk-profile.mjs',
    'src/v2/execution-policy.mjs',
    'src/v2/delivery-plan.mjs',
    'src/v2/remediation-state-machine.mjs',
    'src/v2/release-gate.mjs',
    'src/v2/persistent-state.mjs',
    'src/v2/metrics.mjs',
    'scripts/verify-delivery-v2-completeness.mjs',
    'scripts/verify-delivery-v2-targets.mjs'
  ];
  for (const rel of required) await access(path.join(root, rel));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!pkg.dependencies?.['@openai/codex-sdk']) throw new Error('Missing @openai/codex-sdk dependency');
  console.log(JSON.stringify({ ok: true, defaultEntrypoint: 'plan-v2', required }, null, 2));
}

const [command = 'plan-v2', ...rest] = process.argv.slice(2);
if (command === 'validate') await validate();
else if (command === 'plan-v2') {
  const plan = createDeliveryPlan(loadV2Config(parseArgs(rest)));
  console.log(JSON.stringify(plan, null, 2));
} else if (command === 'resume-v2') {
  const args = parseArgs(rest);
  if (!args.stateFile || !args.repository || !args.pullRequestNumber || !args.headRef || !args.remoteHeadSha) {
    throw new Error('resume-v2 requires --state-file, --repo, --pr, --head-ref and --remote-head from fresh GitHub observation');
  }
  const result = await resumePersistentDelivery({
    filePath: path.resolve(args.stateFile),
    observed: {
      repository: args.repository,
      pullRequestNumber: Number(args.pullRequestNumber),
      headRef: args.headRef,
      remoteHeadSha: args.remoteHeadSha
    }
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'metrics-v2') {
  const args = parseArgs(rest);
  if (!args.metricsFile) throw new Error('metrics-v2 requires --metrics-file');
  const store = await loadDeliveryMetricsStore(path.resolve(args.metricsFile));
  console.log(JSON.stringify(summarizeDeliveryMetrics(store.records), null, 2));
} else {
  throw new Error(`Unknown Delivery V2 command: ${command}`);
}
