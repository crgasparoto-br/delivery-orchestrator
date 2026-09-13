import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('V1 traceability snapshots are physically absent from active tool-discovery roots', async () => {
  assert.equal(await exists('.audit/entregar-issue'), false);
  assert.equal(await exists('skills/catalog'), false);
});

test('removed V1 snapshot roots are ignored so generated/local tooling cannot accidentally reintroduce them', async () => {
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
