import os from 'node:os';
import path from 'node:path';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { copyDir, resetDir } from './files.mjs';

function safeChildEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CI']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

async function run(command, args, { cwd, env = safeChildEnv() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${command} failed (${code})\n${stderr || stdout}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function prepareHome(payload) {
  const root = payload.root || path.join(os.homedir(), '.codex-delivery', payload.role);
  if (payload.persistent) {
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
    const authPath = path.join(root, 'auth.json');
    await access(authPath, fsConstants.R_OK | fsConstants.W_OK);
    await chmod(authPath, 0o600);
  } else {
    await resetDir(root);
    await chmod(root, 0o700);
  }
  const skillsDir = path.join(root, 'skills');
  await resetDir(skillsDir);
  for (const name of payload.names || []) {
    await copyDir(path.join(payload.catalog, name), path.join(skillsDir, name));
  }
  return { root, authPath: payload.persistent ? path.join(root, 'auth.json') : null };
}

async function cloneRepo(payload) {
  await rm(payload.dest, { recursive: true, force: true });
  await mkdir(path.dirname(payload.dest), { recursive: true });
  const env = safeChildEnv({ GH_TOKEN: payload.token, GITHUB_TOKEN: payload.token });
  await run('gh', ['repo', 'clone', payload.repository, path.basename(payload.dest)], { cwd: path.dirname(payload.dest), env });
  if (payload.ref) {
    await run('git', ['checkout', '--detach', payload.ref], { cwd: payload.dest, env });
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: payload.dest, env })).stdout.trim();
    if (head !== payload.ref) throw new Error(`Clone identity mismatch: expected ${payload.ref}, got ${head}`);
  }
  return { dest: payload.dest };
}

async function writeSecret(payload) {
  await mkdir(path.dirname(payload.path), { recursive: true });
  await chmod(path.dirname(payload.path), 0o700);
  await writeFile(payload.path, Buffer.from(payload.base64, 'base64'));
  await chmod(payload.path, 0o600);
  return { path: payload.path };
}

async function probeReadable(payload) {
  try {
    await access(payload.path, fsConstants.R_OK);
    return { path: payload.path, readable: true, exists: true };
  } catch (error) {
    return { path: payload.path, readable: false, exists: error?.code !== 'ENOENT' };
  }
}

async function verifyWorkspace(payload) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: payload.cwd })).stdout.trim();
  const status = (await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: payload.cwd })).stdout.trim();
  return { head, status, clean: !status };
}

async function runCodex(payload) {
  const { Codex } = await import('@openai/codex-sdk');
  const cleanEnv = safeChildEnv(payload.env || {});
  const clientOptions = payload.authMode === 'chatgpt'
    ? { env: cleanEnv, config: { forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file' } }
    : { apiKey: payload.apiKey, env: cleanEnv, config: { forced_login_method: 'api' } };
  if (payload.authMode === 'api-key' && !payload.apiKey) throw new Error('OPENAI_API_KEY is required when CODEX_AUTH_MODE=api-key');
  const codex = new Codex(clientOptions);
  const thread = codex.startThread({
    workingDirectory: payload.workingDirectory,
    model: payload.model,
    sandboxMode: payload.sandboxMode,
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    skipGitRepoCheck: false
  });
  const result = await thread.run(payload.prompt, { outputSchema: payload.outputSchema });
  const text = result.finalResponse?.trim();
  if (!text) throw new Error(`${payload.role} returned an empty final response`);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`${payload.role} returned invalid JSON: ${text}`, { cause: error }); }
  return { contextId: thread.id, result: parsed, usage: result.usage ?? null };
}

export async function executeRoleTask(task, payload) {
  if (task === 'prepare-home') return prepareHome(payload);
  if (task === 'clone') return cloneRepo(payload);
  if (task === 'write-secret') return writeSecret(payload);
  if (task === 'probe-readable') return probeReadable(payload);
  if (task === 'verify-workspace') return verifyWorkspace(payload);
  if (task === 'run-codex') return runCodex(payload);
  if (task === 'reset-dir') { await resetDir(payload.path); if (payload.mode) await chmod(payload.path, payload.mode); return { path: payload.path }; }
  if (task === 'remove-path') { await rm(payload.path, { recursive: true, force: true }); return { removed: payload.path }; }
  throw new Error(`Unsupported role task: ${task}`);
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const task = process.argv[2];
  const input = await readStdin();
  const payload = input.trim() ? JSON.parse(input) : {};
  const result = await executeRoleTask(task, payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
