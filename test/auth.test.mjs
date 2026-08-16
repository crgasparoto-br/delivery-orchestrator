import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexClientOptions, buildRoleEnvironment } from '../src/codex-executor.mjs';
import { resolveAuthMode } from '../src/config.mjs';
import { AUDITOR_SKILLS, IMPLEMENTER_SKILLS } from '../src/constants.mjs';
import { prepareSkillHomes } from '../src/skill-homes.mjs';

test('ChatGPT auth is the default and unsupported modes fail closed', () => {
  assert.equal(resolveAuthMode(undefined), 'chatgpt');
  assert.equal(resolveAuthMode('api-key'), 'api-key');
  assert.throws(() => resolveAuthMode('auto'), /CODEX_AUTH_MODE must be one of/);
});

test('ChatGPT mode strips API credentials and forces ChatGPT login', () => {
  const options = buildCodexClientOptions({
    authMode: 'chatgpt',
    apiKey: 'should-not-be-used',
    env: {
      OPENAI_API_KEY: 'openai-key',
      CODEX_API_KEY: 'codex-key',
      CODEX_ACCESS_TOKEN: 'access-token',
      CODEX_HOME: '/tmp/codex-home',
      KEEP_ME: 'yes'
    }
  });
  assert.equal(options.apiKey, undefined);
  assert.deepEqual(options.config, { forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file' });
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.CODEX_API_KEY, undefined);
  assert.equal(options.env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(options.env.CODEX_HOME, '/tmp/codex-home');
  assert.equal(options.env.KEEP_ME, 'yes');
});

test('API-key mode is explicit and requires a key', () => {
  assert.throws(() => buildCodexClientOptions({ authMode: 'api-key', env: {} }), /OPENAI_API_KEY is required/);
  const options = buildCodexClientOptions({
    authMode: 'api-key', apiKey: 'sk-test', env: { OPENAI_API_KEY: 'stale', KEEP_ME: 'yes' }
  });
  assert.equal(options.apiKey, 'sk-test');
  assert.deepEqual(options.config, { forced_login_method: 'api' });
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.KEEP_ME, 'yes');
});

test('persistent role homes preserve auth but refresh skills and isolate auditor signing key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-auth-test-'));
  const catalog = path.join(root, 'catalog');
  for (const name of new Set([...IMPLEMENTER_SKILLS, ...AUDITOR_SKILLS])) {
    await mkdir(path.join(catalog, name), { recursive: true });
    await writeFile(path.join(catalog, name, 'SKILL.md'), `# ${name}\n`);
  }
  const implementerHome = path.join(root, 'implementer-home');
  const auditorHome = path.join(root, 'auditor-home');
  await mkdir(path.join(implementerHome, 'skills', 'stale'), { recursive: true });
  await mkdir(auditorHome, { recursive: true });
  await writeFile(path.join(implementerHome, 'auth.json'), '{"auth_mode":"chatgpt"}\n');
  await writeFile(path.join(auditorHome, 'auth.json'), '{"auth_mode":"chatgpt"}\n');
  await writeFile(path.join(implementerHome, 'skills', 'stale', 'old.txt'), 'stale\n');
  const runtimeRoot = path.join(root, 'runtime');
  const result = await prepareSkillHomes({
    runtimeRoot, catalog, authMode: 'chatgpt', implementerCodexHome: implementerHome,
    auditorCodexHome: auditorHome, auditorPrivateKeyB64: Buffer.from('private-key').toString('base64')
  });
  assert.match(await readFile(path.join(implementerHome, 'auth.json'), 'utf8'), /chatgpt/);
  assert.match(await readFile(path.join(auditorHome, 'auth.json'), 'utf8'), /chatgpt/);
  await assert.rejects(() => readFile(path.join(implementerHome, 'skills', 'stale', 'old.txt'), 'utf8'));
  assert.match(await readFile(path.join(implementerHome, 'skills', 'entregar-issue', 'SKILL.md'), 'utf8'), /entregar-issue/);
  assert.match(await readFile(path.join(auditorHome, 'skills', 'auditar-issue', 'SKILL.md'), 'utf8'), /auditar-issue/);
  assert.equal(result.auditorPrivateKeyPath.startsWith(auditorHome), false);
  assert.equal(await readFile(result.auditorPrivateKeyPath, 'utf8'), 'private-key');
});

test('implementer and auditor cannot share a persistent CODEX_HOME', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-auth-shared-test-'));
  const catalog = path.join(root, 'catalog');
  for (const name of new Set([...IMPLEMENTER_SKILLS, ...AUDITOR_SKILLS])) await mkdir(path.join(catalog, name), { recursive: true });
  const sharedHome = path.join(root, 'shared-home');
  await assert.rejects(() => prepareSkillHomes({
    runtimeRoot: path.join(root, 'runtime'), catalog, authMode: 'chatgpt',
    implementerCodexHome: sharedHome, auditorCodexHome: sharedHome, auditorPrivateKeyB64: ''
  }), /must be different/);
});

test('workflow keeps ChatGPT auth on a dedicated serialized self-hosted runner and never uploads runtime', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-loop.yml', import.meta.url), 'utf8');
  assert.match(workflow, /runs-on: \[self-hosted, linux, delivery-orchestrator\]/);
  assert.match(workflow, /group: delivery-orchestrator/);
  assert.match(workflow, /CODEX_AUTH_MODE: \$\{\{ vars\.CODEX_AUTH_MODE \|\| 'chatgpt' \}\}/);
  assert.match(workflow, /github\.event\.repository\.private/);
  assert.match(workflow, /find runs -type d -name runtime/);
  assert.match(workflow, /!runs\/\*\*\/runtime\/\*\*/);
  assert.doesNotMatch(workflow, /\bpull_request\s*:/);
});

const credentialBoundaryBaseEnv = {
  PATH: '/usr/bin',
  DELIVERY_GITHUB_WRITE_TOKEN: 'write-secret',
  DELIVERY_GITHUB_READ_TOKEN: 'read-secret',
  AUDITOR_PRIVATE_KEY_B64: 'private-key-secret',
  AUDITOR_KEY_PASSWORD: 'auditor-password',
  AUDITOR_KEY_ID: 'auditor-key-id',
  AUDIT_OUTPUT_DIR: '/tmp/audit-output',
  TRUSTED_AUDITORS_PATH: '/tmp/trusted.json',
  KEEP_ME: 'yes'
};

test('implementer child strips auditor and raw orchestration credentials', () => {
  const env = buildRoleEnvironment({
    baseEnv: credentialBoundaryBaseEnv,
    extraEnv: { AUDITOR_KEY_PASSWORD: 'reintroduced-password' },
    codexHome: '/tmp/implementer', githubToken: 'write-secret', role: 'implementer'
  });
  assert.equal(env.GH_TOKEN, 'write-secret');
  assert.equal(env.GITHUB_TOKEN, 'write-secret');
  for (const key of ['DELIVERY_GITHUB_WRITE_TOKEN','DELIVERY_GITHUB_READ_TOKEN','AUDITOR_PRIVATE_KEY_B64','AUDITOR_KEY_PASSWORD','AUDITOR_KEY_ID','AUDIT_OUTPUT_DIR','TRUSTED_AUDITORS_PATH']) {
    assert.equal(env[key], undefined, `${key} must not cross into implementer`);
  }
  assert.equal(env.KEEP_ME, 'yes');
});

test('auditor child strips write/raw orchestration credentials but keeps explicit audit inputs', () => {
  const env = buildRoleEnvironment({
    baseEnv: credentialBoundaryBaseEnv,
    extraEnv: { AUDITOR_KEY_PASSWORD: 'explicit-password', AUDITOR_KEY_ID: 'explicit-key-id', AUDIT_OUTPUT_DIR: '/tmp/explicit-audit-output' },
    codexHome: '/tmp/auditor', githubToken: 'read-secret', role: 'auditor'
  });
  assert.equal(env.GH_TOKEN, 'read-secret');
  assert.equal(env.GITHUB_TOKEN, 'read-secret');
  for (const key of ['DELIVERY_GITHUB_WRITE_TOKEN','DELIVERY_GITHUB_READ_TOKEN','AUDITOR_PRIVATE_KEY_B64']) assert.equal(env[key], undefined);
  assert.equal(env.AUDITOR_KEY_PASSWORD, 'explicit-password');
  assert.equal(env.AUDITOR_KEY_ID, 'explicit-key-id');
  assert.equal(env.AUDIT_OUTPUT_DIR, '/tmp/explicit-audit-output');
  assert.equal(env.KEEP_ME, 'yes');
});

test('credential boundary fails closed for unknown delivery roles', () => {
  assert.throws(() => buildRoleEnvironment({
    baseEnv: credentialBoundaryBaseEnv, codexHome: '/tmp/unknown', githubToken: 'secret', role: 'reviewer'
  }), /Unsupported delivery role/);
});
