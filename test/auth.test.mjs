import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCodexClientOptions, buildRoleEnvironment, CodexExecutor } from '../src/codex-executor.mjs';
import { resolveAuthMode } from '../src/config.mjs';
import { validateRoleUsers } from '../src/role-runtime.mjs';
import { materializeAuditorPrivateKey, prepareSkillHomes } from '../src/skill-homes.mjs';

test('ChatGPT auth is the default and unsupported modes fail closed', () => {
  assert.equal(resolveAuthMode(undefined), 'chatgpt');
  assert.equal(resolveAuthMode('api-key'), 'api-key');
  assert.throws(() => resolveAuthMode('auto'), /CODEX_AUTH_MODE must be one of/);
});

test('ChatGPT mode strips API credentials and forces ChatGPT login', () => {
  const options = buildCodexClientOptions({
    authMode: 'chatgpt', apiKey: 'should-not-be-used',
    env: { OPENAI_API_KEY: 'openai-key', CODEX_API_KEY: 'codex-key', CODEX_ACCESS_TOKEN: 'access-token', CODEX_HOME: '/tmp/codex-home' }
  });
  assert.equal(options.apiKey, undefined);
  assert.deepEqual(options.config, { forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file' });
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.CODEX_API_KEY, undefined);
  assert.equal(options.env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(options.env.CODEX_HOME, '/tmp/codex-home');
});

test('API-key mode is explicit and requires a key', () => {
  assert.throws(() => buildCodexClientOptions({ authMode: 'api-key', env: {} }), /OPENAI_API_KEY is required/);
  const options = buildCodexClientOptions({ authMode: 'api-key', apiKey: 'sk-test', env: { OPENAI_API_KEY: 'stale' } });
  assert.equal(options.apiKey, 'sk-test');
  assert.deepEqual(options.config, { forced_login_method: 'api' });
  assert.equal(options.env.OPENAI_API_KEY, undefined);
});

test('role users must be distinct valid Linux identities', () => {
  assert.deepEqual(validateRoleUsers('delivery-implementer', 'delivery-auditor'), {
    implementerUser: 'delivery-implementer', auditorUser: 'delivery-auditor'
  });
  assert.throws(() => validateRoleUsers('delivery', 'delivery'), /must be different/);
  assert.throws(() => validateRoleUsers('bad user', 'auditor'), /valid Linux user names/);
});

const credentialBoundaryBaseEnv = {
  PATH: '/usr/bin', LANG: 'C.UTF-8',
  DELIVERY_GITHUB_WRITE_TOKEN: 'write-secret', DELIVERY_GITHUB_READ_TOKEN: 'read-secret',
  AUDITOR_PRIVATE_KEY_B64: 'private-key-secret', AUDITOR_KEY_PASSWORD: 'auditor-password',
  AUDITOR_KEY_ID: 'auditor-key-id', AUDIT_OUTPUT_DIR: '/tmp/audit-output', TRUSTED_AUDITORS_PATH: '/tmp/trusted.json',
  UNKNOWN_RUNNER_SECRET: 'must-not-cross'
};

test('implementer child gets only safe base environment plus explicit role inputs', () => {
  const env = buildRoleEnvironment({
    baseEnv: credentialBoundaryBaseEnv,
    extraEnv: { AUDITOR_KEY_PASSWORD: 'reintroduced-password' },
    codexHome: '/tmp/implementer', githubToken: 'write-secret', role: 'implementer'
  });
  assert.equal(env.GH_TOKEN, 'write-secret');
  assert.equal(env.GITHUB_TOKEN, 'write-secret');
  for (const key of ['DELIVERY_GITHUB_WRITE_TOKEN','DELIVERY_GITHUB_READ_TOKEN','AUDITOR_PRIVATE_KEY_B64','AUDITOR_KEY_PASSWORD','AUDITOR_KEY_ID','AUDIT_OUTPUT_DIR','TRUSTED_AUDITORS_PATH','UNKNOWN_RUNNER_SECRET']) {
    assert.equal(env[key], undefined, `${key} must not cross into implementer`);
  }
  assert.equal(env.PATH, '/usr/bin');
});

test('auditor child strips raw orchestration credentials but keeps explicit audit inputs', () => {
  const env = buildRoleEnvironment({
    baseEnv: credentialBoundaryBaseEnv,
    extraEnv: { AUDITOR_KEY_PASSWORD: 'explicit-password', AUDITOR_KEY_ID: 'explicit-key-id', AUDIT_OUTPUT_DIR: '/tmp/explicit-audit-output' },
    codexHome: '/tmp/auditor', githubToken: 'read-secret', role: 'auditor'
  });
  assert.equal(env.GH_TOKEN, 'read-secret');
  assert.equal(env.GITHUB_TOKEN, 'read-secret');
  for (const key of ['DELIVERY_GITHUB_WRITE_TOKEN','DELIVERY_GITHUB_READ_TOKEN','AUDITOR_PRIVATE_KEY_B64','UNKNOWN_RUNNER_SECRET']) assert.equal(env[key], undefined);
  assert.equal(env.AUDITOR_KEY_PASSWORD, 'explicit-password');
  assert.equal(env.AUDITOR_KEY_ID, 'explicit-key-id');
  assert.equal(env.AUDIT_OUTPUT_DIR, '/tmp/explicit-audit-output');
});

test('persistent homes are prepared under role users and cross-role auth readability is probed both ways', async () => {
  const calls = [];
  async function fake(user, task, payload) {
    calls.push({ user, task, payload });
    if (task === 'prepare-home') {
      const root = payload.role === 'implementer' ? '/home/impl/.codex' : '/home/audit/.codex';
      return { root, authPath: `${root}/auth.json` };
    }
    if (task === 'probe-readable') return { path: payload.path, readable: false, exists: true };
    throw new Error(`unexpected task ${task}`);
  }
  const homes = await prepareSkillHomes({
    implementerRuntimeRoot: '/tmp/impl', auditorRuntimeRoot: '/tmp/audit', catalog: '/catalog', authMode: 'chatgpt',
    implementerUser: 'delivery-implementer', auditorUser: 'delivery-auditor', runRoleTaskFn: fake
  });
  assert.equal(homes.implementer, '/home/impl/.codex');
  assert.equal(homes.auditor, '/home/audit/.codex');
  assert.deepEqual(calls.filter(c => c.task === 'probe-readable').map(c => [c.user, c.payload.path]), [
    ['delivery-implementer', '/home/audit/.codex/auth.json'],
    ['delivery-auditor', '/home/impl/.codex/auth.json']
  ]);
});

test('persistent homes fail closed when they share a path or when a cross-role read succeeds', async () => {
  await assert.rejects(() => prepareSkillHomes({
    implementerRuntimeRoot: '/tmp/impl', auditorRuntimeRoot: '/tmp/audit', catalog: '/catalog', authMode: 'chatgpt',
    implementerCodexHome: '/shared', auditorCodexHome: '/shared',
    implementerUser: 'delivery-implementer', auditorUser: 'delivery-auditor', runRoleTaskFn: async () => ({})
  }), /must be different/);
  async function readable(user, task, payload) {
    if (task === 'prepare-home') {
      const root = payload.role === 'implementer' ? '/home/impl/.codex' : '/home/audit/.codex';
      return { root, authPath: `${root}/auth.json` };
    }
    if (task === 'probe-readable') return { path: payload.path, readable: user === 'delivery-implementer', exists: true };
  }
  await assert.rejects(() => prepareSkillHomes({
    implementerRuntimeRoot: '/tmp/impl', auditorRuntimeRoot: '/tmp/audit', catalog: '/catalog', authMode: 'chatgpt',
    implementerUser: 'delivery-implementer', auditorUser: 'delivery-auditor', runRoleTaskFn: readable
  }), /Filesystem isolation failed/);
});

test('auditor signing key is materialized only for auditor and probed against implementer', async () => {
  const calls = [];
  async function fake(user, task, payload) {
    calls.push({ user, task, payload });
    if (task === 'write-secret') return { path: payload.path };
    if (task === 'probe-readable') return { path: payload.path, readable: false, exists: true };
  }
  const keyPath = await materializeAuditorPrivateKey({
    auditorRuntimeRoot: '/tmp/audit-runtime', auditorPrivateKeyB64: Buffer.from('private').toString('base64'),
    implementerUser: 'delivery-implementer', auditorUser: 'delivery-auditor', runRoleTaskFn: fake
  });
  assert.equal(keyPath, '/tmp/audit-runtime/secrets/auditor-private.pem');
  assert.equal(calls[0].user, 'delivery-auditor');
  assert.equal(calls[0].task, 'write-secret');
  assert.equal(calls[1].user, 'delivery-implementer');
  assert.equal(calls[1].task, 'probe-readable');
});

test('Codex executor dispatches each role under its dedicated Linux user', async () => {
  const calls = [];
  const executor = new CodexExecutor({
    apiKey: 'sk-test', authMode: 'api-key', model: 'model',
    implementerUser: 'delivery-implementer', auditorUser: 'delivery-auditor',
    runRoleTaskFn: async (user, task, payload) => { calls.push({ user, task, payload }); return { contextId: 'ctx', result: { status: 'ok' }, usage: null }; }
  });
  await executor.runFresh({ workingDirectory: '/tmp/repo', codexHome: '/tmp/home', prompt: 'p', outputSchema: {}, role: 'implementer', githubToken: 'write', sandboxMode: 'workspace-write' });
  assert.equal(calls[0].user, 'delivery-implementer');
  assert.equal(calls[0].task, 'run-codex');
  assert.equal(calls[0].payload.env.GH_TOKEN, 'write');
});

test('credential boundary fails closed for unknown delivery roles', () => {
  assert.throws(() => buildRoleEnvironment({ baseEnv: credentialBoundaryBaseEnv, codexHome: '/tmp/unknown', githubToken: 'secret', role: 'reviewer' }), /Unsupported delivery role/);
});

test('workflow requires separate Linux users, cross-role auth probes, serialized private runner and runtime exclusion', async () => {
  const workflow = await readFile(new URL('../.github/workflows/delivery-loop.yml', import.meta.url), 'utf8');
  assert.match(workflow, /runs-on: \[self-hosted, linux, delivery-orchestrator\]/);
  assert.match(workflow, /group: delivery-orchestrator/);
  assert.match(workflow, /DELIVERY_IMPLEMENTER_USER/);
  assert.match(workflow, /DELIVERY_AUDITOR_USER/);
  assert.match(workflow, /sudo -n -u "\$implementer_user"/);
  assert.match(workflow, /sudo -n -u "\$auditor_user"/);
  assert.match(workflow, /Cross-role credential read/);
  assert.match(workflow, /!runs\/\*\*\/runtime\/\*\*/);
  assert.doesNotMatch(workflow, /\bpull_request\s*:/);
});
