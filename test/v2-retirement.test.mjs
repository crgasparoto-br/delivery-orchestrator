import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const retiredPaths = [
  '.github/workflows/delivery-loop.yml',
  'scripts/normalize-delivery-request.mjs',
  'scripts/pump-control-queue.mjs',
  'scripts/resolve-bound-pr.mjs',
  'src/control-queue.mjs',
  'src/delivery-request.mjs',
  'src/orchestrator.mjs',
  'src/state-machine.mjs',
  'src/config.mjs',
  'src/release-finalizer.mjs',
  'src/pr-release-signal.mjs',
  'src/skill-catalog-sync.mjs',
  'src/skill-homes.mjs',
  'src/git-workspace.mjs',
  'src/github-ci.mjs',
  'src/fingerprint.mjs',
  'src/prompts.mjs',
  'src/schemas.mjs',
  'src/constants.mjs',
  'src/pull-request-binding.mjs',
  'schemas/run-state.schema.json',
  'prompts/implementer.md',
  'prompts/auditor.md',
  'skills/orquestrar-entrega/SKILL.md',
  'docs/persistent-delivery-queue.md',
  'docs/delivery-completion-contract.md'
];

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, root));
    return true;
  } catch {
    return false;
  }
}

test('DV2-014 removes every active V1 orchestration surface', async () => {
  const present = [];
  for (const relativePath of retiredPaths) if (await exists(relativePath)) present.push(relativePath);
  assert.deepEqual(present, []);
});

test('V2 is the default CLI and package entrypoint', async () => {
  const cli = await readFile(new URL('src/cli.mjs', root), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.match(cli, /command = 'plan-v2'/);
  assert.doesNotMatch(cli, /runDelivery|finalizeIndependentRelease|loadConfig|verifySynchronizedSkillCatalog/);
  assert.equal(pkg.scripts.run, 'node src/cli.mjs plan-v2');
  assert.doesNotMatch(JSON.stringify(pkg), /max_cycles|delivery-request|Independent delivery loop/i);
});

test('normal-path docs point to V2 and preserve legacy material only as history', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8');
  const security = await readFile(new URL('docs/SECURITY.md', root), 'utf8');
  assert.match(readme, /Delivery V2 - Dispatch/);
  assert.match(readme, /V1 is retired/i);
  assert.match(readme, /historical traceability/i);
  assert.doesNotMatch(readme, /trusted delivery-request control issue|max(?:imum)? cycle count/i);
  assert.match(security, /deterministic control plane/i);
  assert.doesNotMatch(security, /signing private key|implementer can read the materialized auditor signing key/i);
});

test('retirement evidence records an empty legacy queue and retained history boundary', async () => {
  const evidence = JSON.parse(await readFile(new URL('docs/delivery-v2/evidence/dv2-014-v1-retirement.json', root), 'utf8'));
  assert.equal(evidence.requirement, 'DV2-014');
  assert.equal(evidence.openLegacyControlIssuesAtRetirement, 0);
  assert.equal(evidence.v2DefaultEntrypoint, '.github/workflows/delivery-v2-dispatch.yml');
  assert.deepEqual(evidence.retainedForTraceability, ['.audit/entregar-issue/**', 'skills/catalog/**']);
});
