import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('GitHub-native auditor does not shadow the bounded diff preflight helper inside main', async () => {
  const script = await readFile(new URL('../scripts/run-delivery-v2-github-audit.mjs', import.meta.url), 'utf8');

  assert.match(script, /function boundedDiffPreflightReasons\(manifest\)/);
  assert.match(script, /const diffPreflightReasons = boundedDiffPreflightReasons\(diffEvidence\.manifest\)/);
  assert.match(script, /const boundedPreflightReasons = diffPreflightReasons\.map/);
  assert.doesNotMatch(script, /\b(?:const|let|var)\s+boundedDiffPreflightReasons\b/);
});
