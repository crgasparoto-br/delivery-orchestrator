import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { verifySynchronizedSkillCatalog } from '../src/skill-catalog-sync.mjs';

test('synchronized skill catalog validates against the GPT Web manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-skill-sync-test-'));
  await cp(new URL('../skills', import.meta.url), path.join(root, 'skills'), { recursive: true });
  const result = await verifySynchronizedSkillCatalog(root);
  assert.ok(result.skills.includes('entregar-issue'));
  assert.ok(result.skills.includes('auditar-issue'));
});

test('catalog drift is rejected before role homes are prepared', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-skill-sync-drift-'));
  await cp(new URL('../skills', import.meta.url), path.join(root, 'skills'), { recursive: true });
  await writeFile(path.join(root, 'skills', 'catalog', 'entregar-issue', 'drift.txt'), 'drift\n');
  await assert.rejects(() => verifySynchronizedSkillCatalog(root), /entregar-issue does not match manifest/);
});
