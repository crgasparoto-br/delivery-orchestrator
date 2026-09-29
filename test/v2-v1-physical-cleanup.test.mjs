import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const LEGACY_SNAPSHOT_ROOTS = [
  '.audit/entregar-issue',
  'skills/catalog'
];

const ACTIVE_RUNTIME_ROOTS = [
  'src',
  'scripts',
  'actions',
  '.github/scripts',
  '.github/workflows'
];

async function collectFiles(root) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

test('V1 traceability snapshots stay outside active runtime and worker roots', async () => {
  const references = [];

  for (const root of ACTIVE_RUNTIME_ROOTS) {
    const files = await collectFiles(root);

    for (const file of files) {
      const source = await readFile(file, 'utf8');

      for (const legacyRoot of LEGACY_SNAPSHOT_ROOTS) {
        if (source.includes(legacyRoot)) {
          references.push(`${file} -> ${legacyRoot}`);
        }
      }
    }
  }

  assert.deepEqual(references, []);
});

test('retired V1 snapshot roots stay ignored so generated/local tooling cannot reactivate them', async () => {
  const gitignore = await readFile('.gitignore', 'utf8');
  assert.match(gitignore, /^\.audit\/$/m);
  assert.match(gitignore, /^skills\/catalog\/$/m);
});

test('DV2-014 evidence records the post-retirement physical cleanup while preserving historical provenance', async () => {
  const evidence = JSON.parse(await readFile('docs/delivery-v2/evidence/dv2-014-v1-retirement.json', 'utf8'));
  assert.equal(evidence.v2_1PhysicalCleanup.issueNumber, 63);
  assert.deepEqual(evidence.v2_1PhysicalCleanup.removedResidualRoots, [
    '.audit/entregar-issue/**',
    'skills/catalog/**'
  ]);
  assert.equal(evidence.v2_1PhysicalCleanup.reintroductionBlockedByGitignore, true);
  assert.equal(evidence.v2_1PhysicalCleanup.runtimeActive, false);
  assert.ok(evidence.v2_1PhysicalCleanup.retainedProvenance.includes('git-history'));
});
