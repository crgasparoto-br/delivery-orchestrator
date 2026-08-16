import test from 'node:test';
import assert from 'node:assert/strict';

// This is a structural test: the real loop is integration-tested in GitHub Actions where gh/Codex are available.
test('structured result contract requires independent release gate for completion', async () => {
  const { AUDIT_RESULT_SCHEMA } = await import('../src/schemas.mjs');
  assert.ok(AUDIT_RESULT_SCHEMA.properties.validity.enum.includes('independent'));
  assert.equal(AUDIT_RESULT_SCHEMA.properties.release_gate_satisfied.type, 'boolean');
});

test('auditor workspace guard rejects local candidate mutation', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runCommand } = await import('../src/process.mjs');
  const { verifyAuditWorkspaceClean } = await import('../src/git-workspace.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delivery-orchestrator-test-'));
  await runCommand('git', ['init'], { cwd: dir });
  await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runCommand('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'candidate.txt'), 'clean\n');
  await runCommand('git', ['add', 'candidate.txt'], { cwd: dir });
  await runCommand('git', ['commit', '-m', 'candidate'], { cwd: dir });
  const expectedHead = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  assert.deepEqual(await verifyAuditWorkspaceClean({ cwd: dir, expectedHead }), { head: expectedHead, clean: true });
  await writeFile(path.join(dir, 'candidate.txt'), 'mutated\n');
  await assert.rejects(() => verifyAuditWorkspaceClean({ cwd: dir, expectedHead }), /Auditor modified the candidate workspace/);
});
