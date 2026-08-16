import path from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { AUDITOR_SKILLS, IMPLEMENTER_SKILLS } from './constants.mjs';
import { copyDir, resetDir } from './files.mjs';

async function buildHome({ root, catalog, names, preserveRoot }) {
  if (preserveRoot) {
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
  } else await resetDir(root);

  const skillsDir = path.join(root, 'skills');
  await resetDir(skillsDir);
  for (const name of names) {
    await copyDir(path.join(catalog, name), path.join(skillsDir, name));
  }
  return root;
}

export async function prepareSkillHomes({
  runtimeRoot,
  catalog,
  auditorPrivateKeyB64,
  authMode = 'api-key',
  implementerCodexHome,
  auditorCodexHome
}) {
  const persistent = authMode === 'chatgpt';
  const implementerRoot = persistent
    ? implementerCodexHome
    : path.join(runtimeRoot, 'codex-home-implementer');
  const auditorRoot = persistent
    ? auditorCodexHome
    : path.join(runtimeRoot, 'codex-home-auditor');

  if (!implementerRoot || !auditorRoot) {
    throw new Error('Persistent ChatGPT auth requires separate implementer and auditor CODEX_HOME paths');
  }
  if (path.resolve(implementerRoot) === path.resolve(auditorRoot)) {
    throw new Error('Implementer and auditor CODEX_HOME paths must be different');
  }

  const implementer = await buildHome({
    root: implementerRoot,
    catalog,
    names: IMPLEMENTER_SKILLS,
    preserveRoot: persistent
  });
  const auditor = await buildHome({
    root: auditorRoot,
    catalog,
    names: AUDITOR_SKILLS,
    preserveRoot: persistent
  });

  const auditorSecretsDir = path.join(runtimeRoot, 'auditor-secrets');
  await resetDir(auditorSecretsDir);
  let auditorPrivateKeyPath = null;
  if (auditorPrivateKeyB64) {
    auditorPrivateKeyPath = path.join(auditorSecretsDir, 'auditor-private.pem');
    await writeFile(auditorPrivateKeyPath, Buffer.from(auditorPrivateKeyB64, 'base64'));
    await chmod(auditorPrivateKeyPath, 0o600);
  }
  return { implementer, auditor, auditorPrivateKeyPath };
}
