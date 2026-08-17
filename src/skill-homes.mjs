import path from 'node:path';
import { AUDITOR_SKILLS, IMPLEMENTER_SKILLS } from './constants.mjs';
import { assertPathUnreadableByRole, runRoleTask, validateRoleUsers } from './role-runtime.mjs';

export async function prepareSkillHomes({
  implementerRuntimeRoot,
  auditorRuntimeRoot,
  catalog,
  authMode = 'api-key',
  implementerCodexHome,
  auditorCodexHome,
  implementerUser,
  auditorUser,
  runRoleTaskFn = runRoleTask
}) {
  validateRoleUsers(implementerUser, auditorUser);
  const persistent = authMode === 'chatgpt';
  const implementerRoot = persistent ? implementerCodexHome : path.join(implementerRuntimeRoot, 'codex-home');
  const auditorRoot = persistent ? auditorCodexHome : path.join(auditorRuntimeRoot, 'codex-home');

  if (persistent && implementerRoot && auditorRoot && path.resolve(implementerRoot) === path.resolve(auditorRoot)) {
    throw new Error('Implementer and auditor CODEX_HOME paths must be different');
  }

  const implementer = await runRoleTaskFn(implementerUser, 'prepare-home', {
    root: implementerRoot || null,
    role: 'implementer',
    catalog,
    names: IMPLEMENTER_SKILLS,
    persistent
  });
  const auditor = await runRoleTaskFn(auditorUser, 'prepare-home', {
    root: auditorRoot || null,
    role: 'auditor',
    catalog,
    names: AUDITOR_SKILLS,
    persistent
  });

  if (path.resolve(implementer.root) === path.resolve(auditor.root)) {
    throw new Error('Implementer and auditor CODEX_HOME paths must be different');
  }
  const implementerProbeTarget = persistent ? auditor.authPath : auditor.root;
  const auditorProbeTarget = persistent ? implementer.authPath : implementer.root;
  await assertPathUnreadableByRole({ readerUser: implementerUser, path: implementerProbeTarget, runRoleTaskFn });
  await assertPathUnreadableByRole({ readerUser: auditorUser, path: auditorProbeTarget, runRoleTaskFn });

  return { implementer: implementer.root, auditor: auditor.root };
}

export async function materializeAuditorPrivateKey({
  auditorRuntimeRoot,
  auditorPrivateKeyB64,
  implementerUser,
  auditorUser,
  runRoleTaskFn = runRoleTask
}) {
  if (!auditorPrivateKeyB64) return null;
  validateRoleUsers(implementerUser, auditorUser);
  const keyPath = path.join(auditorRuntimeRoot, 'secrets', 'auditor-private.pem');
  await runRoleTaskFn(auditorUser, 'write-secret', { path: keyPath, base64: auditorPrivateKeyB64 });
  await assertPathUnreadableByRole({ readerUser: implementerUser, path: keyPath, runRoleTaskFn });
  return keyPath;
}
