import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './process.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER = path.join(HERE, 'role-runtime-worker.mjs');
const USER_RE = /^[a-z_][a-z0-9_-]*[$]?$/i;

export function validateRoleUsers(implementerUser, auditorUser) {
  const impl = String(implementerUser || '').trim();
  const audit = String(auditorUser || '').trim();
  if (!USER_RE.test(impl) || !USER_RE.test(audit)) {
    throw new Error('DELIVERY_IMPLEMENTER_USER and DELIVERY_AUDITOR_USER must be valid Linux user names');
  }
  if (impl === audit) throw new Error('Implementer and auditor Linux users must be different');
  return { implementerUser: impl, auditorUser: audit };
}

export function roleRuntimeWorkerPath(env = process.env) {
  return String(env.DELIVERY_ROLE_RUNTIME_WORKER || '').trim() || DEFAULT_WORKER;
}

function sudoEnv() {
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  for (const key of ['LANG', 'LC_ALL', 'TERM']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export async function runRoleTask(user, task, payload = {}) {
  if (!USER_RE.test(String(user || ''))) throw new Error(`Invalid delivery role user: ${user || '(empty)'}`);
  const result = await runCommand(
    'sudo',
    ['-n', '-u', user, '-H', '--', process.execPath, roleRuntimeWorkerPath(), task],
    { env: sudoEnv(), input: `${JSON.stringify(payload)}\n` }
  );
  const text = result.stdout.trim();
  if (!text) throw new Error(`Role task ${task} for ${user} returned no result`);
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Role task ${task} for ${user} returned invalid JSON`, { cause: error }); }
}

export async function assertPathUnreadableByRole({ readerUser, path: targetPath, runRoleTaskFn = runRoleTask }) {
  const result = await runRoleTaskFn(readerUser, 'probe-readable', { path: targetPath });
  if (result.readable) throw new Error(`Filesystem isolation failed: ${readerUser} can read ${targetPath}`);
  return result;
}
