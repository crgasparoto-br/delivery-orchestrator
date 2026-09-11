import { runCommand } from './process.mjs';
import { runRoleTask } from './role-runtime.mjs';

function githubEnv(token) { return { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }; }

export async function cloneForImplementation({ repository, dest, token, roleUser, branch, runRoleTaskFn = runRoleTask }) {
  if (!token) throw new Error('DELIVERY_GITHUB_WRITE_TOKEN is required');
  if (roleUser) await runRoleTaskFn(roleUser, 'clone', { repository, dest, token, branch });
  else throw new Error('cloneForImplementation requires an isolated roleUser');
  return dest;
}

export async function cloneForAudit({ repository, dest, ref, token, roleUser, runRoleTaskFn = runRoleTask }) {
  if (!token) throw new Error('DELIVERY_GITHUB_READ_TOKEN is required');
  if (roleUser) await runRoleTaskFn(roleUser, 'clone', { repository, dest, ref, token });
  else throw new Error('cloneForAudit requires an isolated roleUser');
  return dest;
}

export async function currentHead(cwd) {
  return (await runCommand('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
}

export async function verifyAuditWorkspaceClean({ cwd, expectedHead, roleUser, runRoleTaskFn = runRoleTask }) {
  if (roleUser) {
    const result = await runRoleTaskFn(roleUser, 'verify-workspace', { cwd });
    if (result.head !== expectedHead) throw new Error(`Auditor changed candidate identity: expected ${expectedHead}, got ${result.head}`);
    if (!result.clean) throw new Error(`Auditor modified the candidate workspace:\n${result.status}`);
    return { head: result.head, clean: true };
  }
  const head = await currentHead(cwd);
  if (head !== expectedHead) throw new Error(`Auditor changed candidate identity: expected ${expectedHead}, got ${head}`);
  const status = (await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd })).stdout.trim();
  if (status) throw new Error(`Auditor modified the candidate workspace:\n${status}`);
  return { head, clean: true };
}
