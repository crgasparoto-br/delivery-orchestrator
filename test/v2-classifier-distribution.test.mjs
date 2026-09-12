import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildClassifierPackage } from '../src/v2/classifier-distribution.mjs';

const SOURCE = '0123456789abcdef0123456789abcdef01234567';
const TARGET = {
  schemaVersion: 1,
  repository: 'owner/example',
  baseBranch: 'develop',
  packageDir: '.delivery-v2',
  riskPolicy: {
    fastSafeRoots: ['apps/web/src/components'],
    standardRoots: ['apps/web/src'],
    criticalRoots: ['apps/web/src/access'],
    criticalPaths: ['apps/web/src/pages/Register.tsx'],
    criticalPathFragments: ['privileged']
  }
};

function writeBundle(bundle) {
  const root = mkdtempSync(join(tmpdir(), 'dv2-classifier-'));
  for (const [path, content] of Object.entries(bundle.files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test('generated package is deterministic and binds source, target and file hashes', () => {
  const first = buildClassifierPackage({ rootDir: process.cwd(), sourceCommit: SOURCE, targetConfig: TARGET });
  const second = buildClassifierPackage({ rootDir: process.cwd(), sourceCommit: SOURCE, targetConfig: TARGET });
  assert.deepEqual(first, second);
  assert.equal(first.lock.source.commit, SOURCE);
  assert.equal(first.lock.target.repository, 'owner/example');
  assert.match(first.lock.canonicalClassifierFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.lock.packageFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.lock.verificationCommand, 'node .delivery-v2/verify.mjs');
});

test('generated verifier accepts intact package and rejects drift', () => {
  const bundle = buildClassifierPackage({ rootDir: process.cwd(), sourceCommit: SOURCE, targetConfig: TARGET });
  const root = writeBundle(bundle);
  const valid = spawnSync(process.execPath, [join(root, 'verify.mjs')], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /package: VALID/);
  writeFileSync(join(root, 'risk-profile.mjs'), `${readFileSync(join(root, 'risk-profile.mjs'), 'utf8')}\n// drift\n`);
  const drifted = spawnSync(process.execPath, [join(root, 'verify.mjs')], { encoding: 'utf8' });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /drift detected/);
});

test('target policy cannot weaken core critical invariants', async () => {
  const bundle = buildClassifierPackage({ rootDir: process.cwd(), sourceCommit: SOURCE, targetConfig: TARGET });
  const root = writeBundle(bundle);
  const runtime = await import(`file://${join(root, 'risk-profile.mjs')}?${Date.now()}`);
  const policy = JSON.parse(readFileSync(join(root, 'policy.json'), 'utf8')).riskPolicy;
  assert.equal(runtime.resolveRiskProfile({ requested: 'fast', changedPaths: ['.github/workflows/ci.yml'], repositoryPolicy: policy }).profile, 'critical');
  assert.equal(runtime.resolveRiskProfile({ changedPaths: ['apps/web/src/access/useAccess.ts'], repositoryPolicy: policy }).profile, 'critical');
  assert.equal(runtime.resolveRiskProfile({ changedPaths: ['apps/web/src/components/Card.tsx'], repositoryPolicy: policy }).profile, 'fast');
  assert.equal(runtime.resolveRiskProfile({ changedPaths: ['apps/web/src/components/privileged-card.tsx'], repositoryPolicy: policy }).profile, 'critical');
  assert.equal(runtime.resolveRiskProfile({ changedPaths: ['unknown/surface.svg'], repositoryPolicy: policy }).profile, 'critical');
});

test('target config rejects unknown fields and traversal', () => {
  assert.throws(() => buildClassifierPackage({ rootDir: process.cwd(), sourceCommit: SOURCE, targetConfig: { ...TARGET, allowDowngrade: true } }), /unsupported target config field/);
  assert.throws(() => buildClassifierPackage({ rootDir: process.cwd(), sourceCommit: SOURCE, targetConfig: { ...TARGET, packageDir: '../escape' } }), /stay inside/);
});
