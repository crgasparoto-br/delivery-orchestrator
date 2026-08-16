import path from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { AUDITOR_SKILLS, IMPLEMENTER_SKILLS } from './constants.mjs';
import { copyDir, resetDir } from './files.mjs';

async function buildHome({ root, catalog, names }) {
  await resetDir(root);
  const skillsDir = path.join(root, 'skills');
  await mkdir(skillsDir, { recursive: true });
  for (const name of names) {
    await copyDir(path.join(catalog, name), path.join(skillsDir, name));
  }
  return root;
}

export async function prepareSkillHomes({ runtimeRoot, catalog, auditorPrivateKeyB64 }) {
  const implementer = await buildHome({ root: path.join(runtimeRoot, 'codex-home-implementer'), catalog, names: IMPLEMENTER_SKILLS });
  const auditor = await buildHome({ root: path.join(runtimeRoot, 'codex-home-auditor'), catalog, names: AUDITOR_SKILLS });
  let auditorPrivateKeyPath = null;
  if (auditorPrivateKeyB64) {
    auditorPrivateKeyPath = path.join(auditor, 'auditor-private.pem');
    await writeFile(auditorPrivateKeyPath, Buffer.from(auditorPrivateKeyB64, 'base64'));
    await chmod(auditorPrivateKeyPath, 0o600);
  }
  return { implementer, auditor, auditorPrivateKeyPath };
}
