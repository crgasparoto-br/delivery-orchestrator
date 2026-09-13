import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const retiredPaths = [
  '.github/workflows/delivery-loop.yml',
  '.github/workflows/delivery-v2-independent-audit.yml',
  'scripts/normalize-delivery-request.mjs',
  'scripts/pump-control-queue.mjs',
  'scripts/resolve-bound-pr.mjs',
  'scripts/finalize-control-request.mjs',
  'scripts/generate-auditor-trust.sh',
  'scripts/run-delivery-v2-independent-audit.mjs',
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
  'src/v2/independent-audit-runtime.mjs',
  'schemas/run-state.schema.json',
  'prompts/implementer.md',
  'prompts/auditor.md',
  'skills/orquestrar-entrega',
  'skills/catalog.sync-manifest.json',
  'trust/trusted-auditors.json',
  'docs/persistent-delivery-queue.md',
  'docs/delivery-completion-contract.md'
];

const forbiddenActiveV1Markers = [
  ['delivery-request', /delivery-request/i],
  ['CONTROL_ISSUE_NUMBER', /CONTROL_ISSUE_NUMBER/],
  ['max_cycles', /\bmax_cycles\b/i],
  ['orquestrar-entrega', /orquestrar-entrega/i],
  ['delivery-loop', /delivery-loop/i],
  ['persistent delivery queue', /persistent delivery queue/i]
];

const historicalRootPattern = /(?:^|[^A-Za-z0-9_$])(?:\.audit(?:\/|\b)|skills\/catalog(?:\/|\b))/i;
const workerSourcePattern = /^delivery-v2-worker-(?:codex|claude|copilot)-(?:fast|standard|critical)\.md$/;
const workerLockPattern = /^delivery-v2-worker-(?:codex|claude|copilot)-(?:fast|standard|critical)\.lock\.yml$/;
const workerContextHygieneFragment = 'Context hygiene: do not inspect or summarize `.audit/**`, `skills/catalog/**`, `.generated/**`, compiled `*.lock.yml`, or other historical/generated delivery artifacts';
const declarativeRequirementSummaries = Object.freeze({
  'DV2-008': 'Independent audit consumes exact GitHub candidate identity and CI evidence directly; a legacy .audit handoff is not mandatory for normal V2 deliveries.',
  'DV2-014': 'Delivery V2 is the only active normal-path entrypoint; the legacy delivery-request queue, recursive max-cycle controller, nested-Skill orchestration, mandatory V1 handoff/certificate path and retired snapshot roots are physically absent from the active tree; only minimal provenance remains under docs/delivery-v2/history/v1 and Git history.'
});

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, root));
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(body, fragment) {
  return body.split(fragment).length - 1;
}

function sanitizeDeclarativeWorkflowText(fileName, body) {
  if (workerSourcePattern.test(fileName)) {
    const count = countOccurrences(body, workerContextHygieneFragment);
    assert.equal(count, 1, `${fileName} must contain exactly one canonical context-hygiene declaration`);
    return body.replace(workerContextHygieneFragment, '');
  }
  if (workerLockPattern.test(fileName)) {
    const count = countOccurrences(body, workerContextHygieneFragment);
    assert.ok(count <= 1, `${fileName} must contain at most one generated context-hygiene declaration`);
    return count === 1 ? body.replace(workerContextHygieneFragment, '') : body;
  }
  return body;
}

async function workflowFiles() {
  const entries = await readdir(new URL('.github/workflows/', root), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function actionDirectories() {
  const entries = await readdir(new URL('actions/', root), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function assertNoActiveLegacyMarkers(relativePath, body) {
  for (const [marker, pattern] of forbiddenActiveV1Markers) {
    assert.doesNotMatch(body, pattern, `${relativePath} reintroduced active V1 marker ${marker}`);
  }
}

test('DV2-014 removes every retired V1 orchestration surface', async () => {
  const present = [];
  for (const relativePath of retiredPaths) if (await exists(relativePath)) present.push(relativePath);
  assert.deepEqual(present, []);
});

test('all GitHub workflow entrypoints are explicitly Delivery V2', async () => {
  const files = await workflowFiles();
  assert.ok(files.includes('delivery-v2-dispatch.yml'));
  assert.ok(files.includes('delivery-v2-audit.yml'));
  assert.equal(files.includes('delivery-v2-independent-audit.yml'), false);
  for (const fileName of files) {
    assert.match(fileName, /^delivery-v2-/, `${fileName} is an undeclared non-V2 workflow entrypoint`);
    const body = sanitizeDeclarativeWorkflowText(fileName, await readFile(new URL(`.github/workflows/${fileName}`, root), 'utf8'));
    assertNoActiveLegacyMarkers(`.github/workflows/${fileName}`, body);
    assert.doesNotMatch(body, historicalRootPattern, `${fileName} has an executable dependency on historical V1 roots`);
  }
});

test('all repository-local action entrypoints are explicitly Delivery V2', async () => {
  const directories = await actionDirectories();
  assert.ok(directories.length > 0);
  for (const directory of directories) {
    assert.match(directory, /^delivery-v2-/, `${directory} is an undeclared non-V2 action entrypoint`);
    const manifestPath = `actions/${directory}/action.yml`;
    assert.equal(await exists(manifestPath), true, `${directory} must expose action.yml`);
    const body = await readFile(new URL(manifestPath, root), 'utf8');
    assertNoActiveLegacyMarkers(manifestPath, body);
    assert.doesNotMatch(body, historicalRootPattern, `${manifestPath} depends on historical V1 roots`);
  }
});

test('package normal-path commands enter Delivery V2 only', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts.run, 'node src/cli.mjs plan-v2');
  assert.equal(pkg.scripts['plan:v2'], 'node src/cli.mjs plan-v2');
  assert.equal(pkg.scripts['resume:v2'], 'node src/cli.mjs resume-v2');
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assertNoActiveLegacyMarkers(`package.json#scripts.${name}`, command);
    assert.doesNotMatch(command, historicalRootPattern, `package script ${name} depends on historical V1 roots`);
  }
});

test('current V2 CLI has no concrete normal-path dependency on retired V1 roots', async () => {
  const cli = await readFile(new URL('src/cli.mjs', root), 'utf8');
  assert.match(cli, /command = 'plan-v2'/);
  assert.doesNotMatch(cli, /runDelivery|finalizeIndependentRelease|loadConfig|verifySynchronizedSkillCatalog/);
  assertNoActiveLegacyMarkers('src/cli.mjs', cli);
  assert.doesNotMatch(cli, historicalRootPattern);
});

test('canonical requirements describe retirement without redefining the runtime surface', async () => {
  const body = await readFile(new URL('config/delivery-v2-requirements.json', root), 'utf8');
  const contract = JSON.parse(body);
  for (const [id, expectedSummary] of Object.entries(declarativeRequirementSummaries)) {
    const requirement = contract.requirements.find((item) => item.id === id);
    assert.ok(requirement, `missing ${id}`);
    assert.equal(requirement.summary, expectedSummary);
  }
  const retirement = contract.requirements.find((requirement) => requirement.id === 'DV2-014');
  assert.equal(retirement.status, 'validated');
  assert.match(retirement.summary, /only active normal-path entrypoint/);
  assert.match(retirement.summary, /physically absent from the active tree/);
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

test('retirement evidence distinguishes historical retention from the current physically-clean tree', async () => {
  const evidence = JSON.parse(await readFile(new URL('docs/delivery-v2/evidence/dv2-014-v1-retirement.json', root), 'utf8'));
  const archivedTrust = JSON.parse(await readFile(new URL('docs/delivery-v2/history/v1/trusted-auditors.json', root), 'utf8'));
  const archivedCatalog = JSON.parse(await readFile(new URL('docs/delivery-v2/history/v1/skills-catalog-sync-manifest.json', root), 'utf8'));
  assert.equal(evidence.requirement, 'DV2-014');
  assert.equal(evidence.openLegacyControlIssuesAtRetirement, 0);
  assert.equal(evidence.v2DefaultEntrypoint, '.github/workflows/delivery-v2-dispatch.yml');
  assert.deepEqual(evidence.retainedForTraceabilityAtRetirement, [
    '.audit/entregar-issue/**',
    'skills/catalog/**',
    'docs/delivery-v2/history/v1/trusted-auditors.json',
    'docs/delivery-v2/history/v1/skills-catalog-sync-manifest.json'
  ]);
  assert.equal(evidence.postRetirementHardening.issueNumber, 59);
  assert.deepEqual(evidence.postRetirementHardening.removedResidualPaths, [
    'scripts/finalize-control-request.mjs',
    'skills/orquestrar-entrega/**'
  ]);
  assert.equal(evidence.finalCleanup.issueNumber, 61);
  assert.deepEqual(evidence.finalCleanup.removedResidualPaths, [
    'scripts/generate-auditor-trust.sh',
    'skills/catalog.sync-manifest.json',
    'trust/trusted-auditors.json'
  ]);
  assert.deepEqual(evidence.finalCleanup.archivedResidualMetadata, {
    trustedAuditors: 'docs/delivery-v2/history/v1/trusted-auditors.json',
    skillCatalogSyncManifest: 'docs/delivery-v2/history/v1/skills-catalog-sync-manifest.json'
  });
  assert.equal(evidence.finalCleanup.archivedResidualMetadataRuntimeActive, false);
  assert.equal(evidence.finalCleanup.capabilityManifestSchemaVersion, 2);
  assert.equal(evidence.finalCleanup.normalPathProof, 'structural-entrypoints');
  assert.equal(evidence.finalCleanup.lexicalScannerIsSecurityBoundary, false);
  assert.equal(evidence.finalCleanup.ghAwUsageArtifactContract, true);
  assert.equal(evidence.v2_1PhysicalCleanup.runtimeActive, false);
  assert.deepEqual(evidence.v2_1PhysicalCleanup.removedResidualRoots, ['.audit/entregar-issue/**', 'skills/catalog/**']);
  assert.equal(evidence.transitionalAuditPilotCleanup.issueNumber, 63);
  assert.equal(evidence.transitionalAuditPilotCleanup.runtimeActive, false);
  assert.equal(evidence.transitionalAuditPilotCleanup.replacementWorkflow, '.github/workflows/delivery-v2-audit.yml');
  assert.equal(evidence.transitionalAuditPilotCleanup.replacementRunner, 'scripts/run-delivery-v2-github-audit.mjs');
  assert.equal(evidence.transitionalAuditPilotCleanup.replacementRuntime, 'src/v2/github-native-audit-runtime.mjs');
  assert.equal(archivedTrust.auditors[0].key_id, 'delivery-independent-auditor-v1');
  assert.equal(archivedCatalog.source, 'chatgpt-web-installed-skills');
});
