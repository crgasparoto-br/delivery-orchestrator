import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const retiredPaths = [
  '.github/workflows/delivery-loop.yml',
  'scripts/normalize-delivery-request.mjs',
  'scripts/pump-control-queue.mjs',
  'scripts/resolve-bound-pr.mjs',
  'scripts/finalize-control-request.mjs',
  'scripts/generate-auditor-trust.sh',
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
  'skills/orquestrar-entrega',
  'skills/catalog.sync-manifest.json',
  'trust/trusted-auditors.json',
  'docs/persistent-delivery-queue.md',
  'docs/delivery-completion-contract.md'
];

const activeRuntimeRoots = ['.github', 'scripts', 'src', 'skills', 'trust'];
const activeRootFiles = ['package.json', 'package-lock.json'];
const historicalRuntimeExclusions = ['skills/catalog/'];
const forbiddenActiveV1Markers = [
  ['delivery-request', /delivery-request/i],
  ['CONTROL_ISSUE_NUMBER', /CONTROL_ISSUE_NUMBER/],
  ['max_cycles', /\bmax_cycles\b/i],
  ['orquestrar-entrega', /orquestrar-entrega/i],
  ['delivery-loop', /delivery-loop/i],
  ['persistent delivery queue', /persistent delivery queue/i]
];
const historicalRuntimeReferences = [
  ['skills/catalog', /skills\/catalog(?:\/|\b)/i],
  ['.audit', /(?:^|[^A-Za-z0-9_$])\.audit(?:[\/\\]|(?=['"`\s;)]|$))/i]
];
const referenceOnlyFragments = [
  'Context hygiene: do not inspect or summarize `.audit/**`, `skills/catalog/**`, `.generated/**`, compiled `*.lock.yml`, or other historical/generated delivery artifacts',
  'Do not use or seek implementation conversation history, .audit/entregar-issue artifacts, hidden implementer reasoning, or any source outside this bundle.'
];
const activeTextSurfaceExtension = /\.(?:md|txt|ya?ml|json|mjs|cjs|js|jsx|ts|tsx|py|sh|toml)$/i;

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, root));
    return true;
  } catch {
    return false;
  }
}

async function listFiles(relativePath) {
  const base = new URL(`${relativePath.replace(/\/$/, '')}/`, root);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = `${relativePath.replace(/\/$/, '')}/${entry.name}`;
    if (historicalRuntimeExclusions.some((prefix) => child === prefix.slice(0, -1) || child.startsWith(prefix))) continue;
    if (entry.isDirectory()) files.push(...await listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function isExecutableDependencySurface(relativePath) {
  if (activeRootFiles.includes(relativePath)) return true;
  if (!activeRuntimeRoots.some((runtimeRoot) => relativePath.startsWith(`${runtimeRoot}/`))) return false;
  const fileName = relativePath.split('/').at(-1) ?? '';
  const extensionless = !fileName.includes('.');
  return extensionless || activeTextSurfaceExtension.test(relativePath);
}

function stripReferenceOnlyProse(line) {
  let candidate = line;
  for (const fragment of referenceOnlyFragments) candidate = candidate.replaceAll(fragment, '');
  return candidate;
}

function historicalReferences(body) {
  const matches = [];
  for (const line of body.split(/\r?\n/)) {
    const candidate = stripReferenceOnlyProse(line);
    for (const [marker, pattern] of historicalRuntimeReferences) {
      if (pattern.test(candidate)) matches.push(marker);
    }
  }
  return [...new Set(matches)];
}

async function activeExecutableFiles() {
  const files = [];
  for (const runtimeRoot of activeRuntimeRoots) files.push(...await listFiles(runtimeRoot));
  for (const rootFile of activeRootFiles) if (await exists(rootFile)) files.push(rootFile);
  return [...new Set(files)].filter(isExecutableDependencySurface).sort();
}

test('DV2-014 removes every active V1 orchestration surface', async () => {
  const present = [];
  for (const relativePath of retiredPaths) if (await exists(relativePath)) present.push(relativePath);
  assert.deepEqual(present, []);
});

test('active runtime trees cannot reintroduce V1 orchestration markers outside historical snapshots', async () => {
  const matches = [];
  for (const relativePath of await activeExecutableFiles()) {
    const body = await readFile(new URL(relativePath, root), 'utf8');
    for (const [marker, pattern] of forbiddenActiveV1Markers) {
      if (pattern.test(body)) matches.push(`${relativePath}:${marker}`);
    }
  }
  assert.deepEqual(matches, []);
});

test('active executable surfaces cannot reference historical V1 snapshot trees except explicit negative isolation prose', async () => {
  const matches = [];
  for (const relativePath of await activeExecutableFiles()) {
    const body = await readFile(new URL(relativePath, root), 'utf8');
    for (const marker of historicalReferences(body)) matches.push(`${relativePath}:${marker}`);
  }
  assert.deepEqual(matches, []);
});

test('historical reference gate is fail-closed across manifests, workflow uses, shell and variable-built code paths', () => {
  assert.deepEqual(historicalReferences("const legacy = '.audit/entregar-issue'; await readFile(path.join(root, legacy, 'handoff-ready.json'))"), ['.audit']);
  assert.deepEqual(historicalReferences("const legacyRoot = '.audit'; await readFile(path.join(root, legacyRoot, 'handoff-ready.json'))"), ['.audit']);
  assert.deepEqual(historicalReferences('run: cat .audit/entregar-issue/handoff-ready.json'), ['.audit']);
  assert.deepEqual(historicalReferences('uses: ./skills/catalog/example/action'), ['skills/catalog']);
  assert.deepEqual(historicalReferences('{"scripts":{"legacy":"node skills/catalog/legacy.js"}}'), ['skills/catalog']);
  assert.deepEqual(historicalReferences('steps.risk.outputs.audit-required'), []);
  assert.deepEqual(historicalReferences('durations.audit'), []);
  assert.deepEqual(historicalReferences("'durationsMs.audit'"), []);
  assert.deepEqual(historicalReferences('Context hygiene: do not inspect or summarize `.audit/**`, `skills/catalog/**`, `.generated/**`, compiled `*.lock.yml`, or other historical/generated delivery artifacts unless needed.'), []);
  assert.deepEqual(historicalReferences('Do not use or seek implementation conversation history, .audit/entregar-issue artifacts, hidden implementer reasoning, or any source outside this bundle.'), []);
  assert.deepEqual(historicalReferences('run: cat .audit/entregar-issue/handoff-ready.json # Do not use or seek implementation conversation history, .audit/entregar-issue artifacts, hidden implementer reasoning, or any source outside this bundle.'), ['.audit']);
  assert.equal(isExecutableDependencySurface('package.json'), true);
  assert.equal(isExecutableDependencySurface('.github/workflows/delivery-v2-worker-codex-fast.lock.yml'), true);
  assert.equal(isExecutableDependencySurface('.github/workflows/delivery-v2-worker-codex-critical.md'), true);
  assert.equal(isExecutableDependencySurface('.github/actions/delivery-v2-risk/action.yml'), true);
  assert.equal(isExecutableDependencySurface('skills/foo/SKILL.md'), true);
  assert.equal(isExecutableDependencySurface('scripts/legacy-runner'), true);
});

test('capability manifest describes only the active V2 architecture', async () => {
  const capabilities = JSON.parse(await readFile(new URL('.github/delivery-orchestrator-capabilities.json', root), 'utf8'));
  assert.equal(capabilities.schema_version, 2);
  assert.equal(capabilities.delivery_architecture, 'v2');
  assert.equal(capabilities.persistent_delivery_state, 'enabled');
  assert.equal(capabilities.canonical_pr_binding, 'enabled');
  assert.equal(capabilities.legacy_runtime, 'retired');
  assert.equal(Object.hasOwn(capabilities, 'persistent_control_queue'), false);
  for (const [key, value] of Object.entries(capabilities)) {
    if (key === 'gh_aw_compiler') continue;
    assert.notEqual(value, 'v1', `${key} must not advertise V1 as an active capability`);
  }
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
  assert.equal(evidence.postRetirementHardening.issueNumber, 59);
  assert.deepEqual(evidence.postRetirementHardening.removedResidualPaths, [
    'scripts/finalize-control-request.mjs',
    'skills/orquestrar-entrega/**'
  ]);
  assert.equal(evidence.postRetirementHardening.runtimeMarkerScan, true);
  assert.equal(evidence.finalCleanup.issueNumber, 61);
  assert.deepEqual(evidence.finalCleanup.removedResidualPaths, [
    'scripts/generate-auditor-trust.sh',
    'skills/catalog.sync-manifest.json',
    'trust/trusted-auditors.json'
  ]);
  assert.equal(evidence.finalCleanup.capabilityManifestSchemaVersion, 2);
  assert.equal(evidence.finalCleanup.activeRuntimeMarkerScan, true);
  assert.equal(evidence.finalCleanup.historicalDependencyScan, true);
  assert.equal(evidence.finalCleanup.ghAwUsageArtifactContract, true);
});
