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

const retiredPilotPaths = [
  '.github/workflows/delivery-v2-independent-audit.yml',
  'scripts/run-delivery-v2-independent-audit.mjs',
  'src/v2/independent-audit-runtime.mjs',
  'test/v2-independent-audit-runtime.test.mjs',
  'test/v2-critical-audit-pilot-evidence.test.mjs'
];

test('transitional issue-27 audit pilot surfaces are physically retired', async () => {
  const present = [];
  for (const path of retiredPilotPaths) if (await exists(path)) present.push(path);
  assert.deepEqual(present, []);
});

test('generic audit is the single active semantic-review path and has no pilot marker dependency', async () => {
  const workflow = await readFile('.github/workflows/delivery-v2-audit.yml', 'utf8');
  const runner = await readFile('scripts/run-delivery-v2-github-audit.mjs', 'utf8');
  const runtime = await readFile('src/v2/github-native-audit-runtime.mjs', 'utf8');
  const active = `${workflow}\n${runner}\n${runtime}`;

  assert.match(workflow, /target_repository:/);
  assert.match(workflow, /target_pr:/);
  assert.match(workflow, /source_workflow_run_id:/);
  assert.match(workflow, /run-delivery-v2-github-audit\.mjs/);
  assert.doesNotMatch(active, /DV2-AUDIT-PILOT|assertTrustedCriticalAuditPilot|TARGET_ISSUE:\s*['"]27['"]/);
});
