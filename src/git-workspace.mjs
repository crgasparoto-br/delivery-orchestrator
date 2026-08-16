import path from 'node:path';
import { resetDir } from './files.mjs';
import { runCommand } from './process.mjs';

function githubEnv(token) {
  return { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
}

export async function cloneForImplementation({ repository, dest, token }) {
  if (!token) throw new Error('DELIVERY_GITHUB_WRITE_TOKEN is required');
  await resetDir(path.dirname(dest));
  const parent = path.dirname(dest);
  await runCommand('gh', ['repo', 'clone', repository, path.basename(dest)], { cwd: parent, env: githubEnv(token) });
  return dest;
}

export async function cloneForAudit({ repository, dest, ref, token }) {
  if (!token) throw new Error('DELIVERY_GITHUB_READ_TOKEN is required');
  await resetDir(path.dirname(dest));
  const parent = path.dirname(dest);
  await runCommand('gh', ['repo', 'clone', repository, path.basename(dest)], { cwd: parent, env: githubEnv(token) });
  await runCommand('git', ['checkout', '--detach', ref], { cwd: dest, env: githubEnv(token) });
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: dest, env: githubEnv(token) })).stdout.trim();
  if (head !== ref) throw new Error(`Auditor clone identity mismatch: expected ${ref}, got ${head}`);
  return dest;
}

export async function currentHead(cwd) {
  return (await runCommand('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
}

export async function verifyAuditWorkspaceClean({ cwd, expectedHead }) {
  const head = await currentHead(cwd);
  if (head !== expectedHead) {
    throw new Error(`Auditor changed candidate identity: expected ${expectedHead}, got ${head}`);
  }
  const status = (await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd })).stdout.trim();
  if (status) {
    throw new Error(`Auditor modified the candidate workspace:\n${status}`);
  }
  return { head, clean: true };
}
