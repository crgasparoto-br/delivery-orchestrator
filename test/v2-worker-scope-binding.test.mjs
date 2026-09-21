import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertChangedPathsAuthorized,
  createWorkerScopeBinding,
  validateWorkerScopeBinding
} from '../.github/scripts/delivery-v2-worker-scope-contract.mjs';
import {
  assertEvidenceOnlyNoMaterialPatch,
  changedPathsFromPatchFile,
  isEvidenceOnlyContext
} from '../.github/scripts/validate-delivery-v2-worker-scope.mjs';
import { bootstrapLeaseForDecision } from '../scripts/reserve-delivery-v2-initial-attempt.mjs';

const REPOSITORY = 'crgasparoto-br/training-system';
const AUTHORIZED_FILE = 'apps/api/tests/AI_ROUTING_GUARD_POSTFIX_SMOKE_TEST.md';
const ISSUE = Object.freeze({
  number: 440,
  title: '[smoke-test] Validar guard do worker STANDARD após correção do Delivery V2',
  body: `Criar somente \`${AUTHORIZED_FILE}\`.`
});

function binding() {
  return createWorkerScopeBinding({ repository: REPOSITORY, issue: ISSUE, authorizedPaths: [AUTHORIZED_FILE] });
}

test('explicit changed_paths becomes an exclusive trusted worker boundary', () => {
  const scope = binding();
  assert.equal(scope.enforcement, 'explicit-exclusive');
  assert.deepEqual(scope.authorizedPaths, [AUTHORIZED_FILE]);
  assert.equal(scope.issueContractSha256.length, 64);
  assert.deepEqual(assertChangedPathsAuthorized([AUTHORIZED_FILE], scope).changedPaths, [AUTHORIZED_FILE]);
});

test('regression #440/#441: WorkoutBuilder2 output is rejected before safe outputs', () => {
  const scope = binding();
  const escaped = [
    'apps/web/src/components/WorkoutBuilder2/WorkoutBuilder2.tsx',
    'apps/web/src/components/WorkoutBuilder2/WorkoutBuilder2.test.tsx',
    'apps/web/src/components/WorkoutBuilder2/hooks/useWorkoutBuilder.ts',
    'apps/web/src/components/WorkoutBuilder2/types.ts',
    'apps/web/src/components/WorkoutBuilder2/utils.ts'
  ];
  assert.throws(
    () => assertChangedPathsAuthorized(escaped, scope),
    /candidate patch escapes controller-authorized scope/
  );
});

test('issue contract mutation invalidates the trusted scope binding', () => {
  const scope = binding();
  assert.throws(
    () => validateWorkerScopeBinding(scope, { repository: REPOSITORY, issue: { ...ISSUE, body: `${ISSUE.body}\nexpanded later` } }),
    /issue contract changed/
  );
});

test('bootstrap lease persists the trusted scope binding used by detection', () => {
  const scope = binding();
  const lease = bootstrapLeaseForDecision({
    decision: { dispatchAllowed: true, securityProfile: 'standard' },
    repository: REPOSITORY,
    issueNumber: ISSUE.number,
    baseBranch: 'develop',
    provider: 'codex',
    model: 'gpt-5.4',
    requestedRisk: 'standard',
    runId: 34917667768,
    workerWorkflow: 'delivery-v2-worker-codex-standard.lock.yml',
    dispatchNonce: 'scope-test-nonce',
    scopeBinding: scope
  });
  assert.deepEqual(lease.scopeBinding, scope);
});

test('candidate patch parser identifies the material file before scope authorization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-scope-test-'));
  try {
    const patchFile = path.join(root, 'aw.patch');
    await writeFile(patchFile, [
      `diff --git a/${AUTHORIZED_FILE} b/${AUTHORIZED_FILE}`,
      'new file mode 100644',
      'index 0000000..ce01362',
      '--- /dev/null',
      `+++ b/${AUTHORIZED_FILE}`,
      '@@ -0,0 +1 @@',
      '+Delivery V2 scope smoke test.',
      ''
    ].join('\n'));
    assert.deepEqual(await changedPathsFromPatchFile(patchFile), [AUTHORIZED_FILE]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing candidate patch fails closed with a deterministic no-material error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-scope-missing-patch-'));
  try {
    await assert.rejects(
      () => changedPathsFromPatchFile(path.join(root, 'aw.patch')),
      /candidate patch is missing; worker produced no material patch to authorize/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('all implementation workers import deterministic issue context and scope guard', async () => {
  const providers = ['copilot', 'codex', 'claude'];
  const risks = ['fast', 'standard', 'critical'];
  for (const provider of providers) {
    for (const risk of risks) {
      const source = await readFile(`.github/workflows/delivery-v2-worker-${provider}-${risk}.md`, 'utf8');
      assert.match(source, /imports:\s*\n\s*- shared\/delivery-v2-worker-scope-guard\.md/);
    }
  }
  const shared = await readFile('.github/workflows/shared/delivery-v2-worker-scope-guard.md', 'utf8');
  assert.match(shared, /Materialize trusted target issue context/);
  assert.match(shared, /GH_TOKEN: \$\{\{ secrets\.DELIVERY_GITHUB_READ_TOKEN \}\}/);
  assert.doesNotMatch(shared, /GH_TOKEN: \$\{\{ secrets\.DELIVERY_GITHUB_WRITE_TOKEN \}\}/);
  assert.match(shared, /\/tmp\/gh-aw\/agent\/delivery-v2-target-issue\.json/);
  assert.match(shared, /Do not rely on `gh issue view`/);
  assert.match(shared, /authoritative task contract/);
  assert.match(shared, /Validate controller-authorized material scope/);
  assert.match(shared, /find \/tmp\/gh-aw\/threat-detection -maxdepth 1 -type f -name '\*\.patch'/);
  assert.match(shared, /expected exactly one candidate patch/);
  assert.match(shared, /export PATCH_PATH="\$\{patch_files\[0\]\}"/);
  assert.doesNotMatch(shared, /PATCH_PATH: \/tmp\/gh-aw\/threat-detection\/aw\.patch/);
  assert.match(shared, /persist-credentials: false/);
});

test('evidence-only technical hygiene rejects every material patch before safe outputs', () => {
  const evidenceOnly = JSON.stringify({
    kind: 'technical-hygiene-evidence-promotion',
    evidenceOnly: true
  });

  assert.equal(isEvidenceOnlyContext(evidenceOnly), true);
  assert.equal(isEvidenceOnlyContext('{invalid-json'), false);
  assert.equal(isEvidenceOnlyContext(JSON.stringify({ evidenceOnly: false })), false);

  assert.throws(
    () => assertEvidenceOnlyNoMaterialPatch(evidenceOnly, [AUTHORIZED_FILE]),
    /evidence-only worker produced material patch/
  );

  assert.equal(
    assertEvidenceOnlyNoMaterialPatch(
      JSON.stringify({ evidenceOnly: false }),
      [AUTHORIZED_FILE]
    ),
    true
  );
});
