import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const master = readFileSync(new URL('../docs/delivery-v2/MASTER_SPEC.md', import.meta.url), 'utf8');
const heading = '### 20.1 Legacy PR adoption before complete operational evidence';

function adoptionSection(document) {
  const start = document.indexOf(heading);
  const end = document.indexOf('\n### 20.2 ', start);
  assert.ok(start >= 0 && end > start, 'legacy adoption section must be present');
  return document.slice(start, end);
}

function assertRecoveryContract(section) {
  assert.match(section, /\[section 8\.1\]\(#81-pre-material-control-plane-recovery\)/);
  const authorization = section.match(/\*\*legacy authorization-failure recovery\*\*([^\n]+?)\. The distinct /)?.[1];
  assert.ok(authorization, 'the no-patch predicates must be scoped to authorization-failure recovery');
  for (const predicate of ['authorization-mismatch', 'skipped-agent', '`hasPatch=false`', 'worker-identity', 'changed-control-plane']) {
    assert.ok(authorization.includes(predicate), `authorization recovery must retain ${predicate}`);
  }
  const scope = section.match(/\*\*scope-correction re-entry\*\*([^\n]+?)\. Both variants /)?.[1];
  assert.ok(scope, 'local-patch scope correction must be a separate recovery variant');
  for (const predicate of ['`hasPatch=true`', 'material scope guard', 'unchanged repository/issue/`issueContractSha256`', 'authoritative changed paths fully covered by a corrected explicit scope', 'no published managed PR']) {
    assert.ok(scope.includes(predicate), `scope correction must retain ${predicate}`);
  }
  assert.match(section, /Both variants reuse the same implementation-attempt number, preserve recovery provenance and grant no additional budget/);
  assert.match(section, /neither permits generic reopening of nonrecoverable failures/);
  assert.match(section, /When a trusted material PR is already present, those rearm predicates are intentionally not prerequisites because no historical attempt is resumed/);
}

const adoption = adoptionSection(master);

test('legacy adoption documents both narrow recovery variants without weakening their predicates', () => {
  assertRecoveryContract(adoption);
});

// Mutation controls prove that green documentation checks reject the old ambiguity
// and loss of an independent safety predicate, rather than merely finding a heading.
for (const [name, original, replacement] of [
  ['unqualified no-patch recovery', '**legacy authorization-failure recovery**', 'recovery'],
  ['lost no-patch authorization guard', '`hasPatch=false`', '`hasPatch=true`'],
  ['lost local-patch scope guard', '`hasPatch=true`', '`hasPatch=false`'],
  ['changed issue contract', 'unchanged repository/issue/`issueContractSha256`', 'current issue context'],
  ['incomplete authorized scope', 'authoritative changed paths fully covered by a corrected explicit scope', 'some authorized paths'],
  ['remote material already published', 'no published managed PR', 'a published managed PR'],
  ['additional attempt budget', 'grant no additional budget', 'grant additional budget'],
  ['lost recovery provenance', 'preserve recovery provenance', 'replace recovery provenance'],
  ['generic nonrecoverable reopening', 'neither permits generic reopening', 'either permits generic reopening'],
  ['broken canonical link', '#81-pre-material-control-plane-recovery', '#missing-recovery-matrix']
]) {
  test(`recovery documentation rejects ${name}`, () => {
    assert.ok(adoption.includes(original), `mutation must change the source: ${name}`);
    const mutated = adoption.replace(original, replacement);
    assert.notEqual(mutated, adoption);
    assert.throws(() => assertRecoveryContract(mutated), assert.AssertionError);
  });
}
