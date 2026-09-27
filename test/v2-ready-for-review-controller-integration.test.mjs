import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const controllerFiles = [
  '../scripts/run-delivery-v2-controller.mjs',
  '../scripts/resume-delivery-v2-controller.mjs'
];

async function sourceFor(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function assertReleasePromotionOrdering(source, label) {
  const guard = source.indexOf("if (!release.readiness) throw new Error(");
  const publish = source.indexOf("await publishReleaseStatus(", guard);
  const promote = source.indexOf("await markPullRequestReadyForReview(", publish);
  const persist = source.indexOf("await persist({ nextAction: 'human-merge-policy', release });", promote);

  assert.notEqual(guard, -1, `${label}: missing release readiness fail-closed guard`);
  assert.notEqual(publish, -1, `${label}: missing exact-head release status publication`);
  assert.notEqual(promote, -1, `${label}: missing ready-for-review promotion`);
  assert.notEqual(persist, -1, `${label}: missing human-merge terminal transition`);
  assert.ok(guard < publish, `${label}: release guard must run before status publication`);
  assert.ok(publish < promote, `${label}: promotion must run only after release status publication`);
  assert.ok(promote < persist, `${label}: promotion must complete before human-merge terminal state`);
}

for (const controllerFile of controllerFiles) {
  test(`${controllerFile} promotes draft PR only after release readiness and keeps human merge terminal`, async () => {
    const source = await sourceFor(controllerFile);

    assert.match(
      source,
      /markPullRequestReadyForReview/,
      'controller must wire the ready-for-review transition'
    );

    assertReleasePromotionOrdering(source, controllerFile);

    assert.doesNotMatch(
      source,
      /mergePullRequest|mergePullRequest\s*\(|mutation\s+MergePullRequest/i,
      'controller must not add automatic merge behavior'
    );
  });
}

test('both initial and resume controllers retain the same fail-closed release-to-promotion sequence', async () => {
  const [initial, resume] = await Promise.all(controllerFiles.map(sourceFor));

  for (const [label, source] of [['initial', initial], ['resume', resume]]) {
    const guard = source.indexOf("if (!release.readiness) throw new Error(");
    const promote = source.indexOf("await markPullRequestReadyForReview(", guard);

    assert.notEqual(guard, -1, `${label}: release readiness guard is required`);
    assert.notEqual(promote, -1, `${label}: promotion call is required`);
    assert.ok(
      promote > guard,
      `${label}: a rejected release must terminate before any ready-for-review mutation`
    );
  }
});
