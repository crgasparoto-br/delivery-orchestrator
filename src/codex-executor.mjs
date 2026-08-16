const AUTH_ENV_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
const ORCHESTRATOR_ONLY_ENV_KEYS = [
  'DELIVERY_GITHUB_WRITE_TOKEN',
  'DELIVERY_GITHUB_READ_TOKEN',
  'AUDITOR_PRIVATE_KEY_B64'
];
const IMPLEMENTER_FORBIDDEN_ENV_KEYS = [
  'AUDITOR_KEY_PASSWORD',
  'AUDITOR_KEY_ID',
  'AUDIT_OUTPUT_DIR',
  'TRUSTED_AUDITORS_PATH'
];
const ROLES = new Set(['implementer', 'auditor']);

export function buildCodexClientOptions({ authMode, apiKey, env }) {
  const cleanEnv = { ...env };
  for (const key of AUTH_ENV_KEYS) delete cleanEnv[key];

  if (authMode === 'chatgpt') {
    return {
      env: cleanEnv,
      config: { forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file' }
    };
  }

  if (authMode === 'api-key') {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when CODEX_AUTH_MODE=api-key');
    return {
      apiKey,
      env: cleanEnv,
      config: { forced_login_method: 'api' }
    };
  }

  throw new Error(`Unsupported Codex auth mode: ${authMode}`);
}

export function buildRoleEnvironment({ baseEnv, extraEnv = {}, codexHome, githubToken, role }) {
  if (!ROLES.has(role)) throw new Error(`Unsupported delivery role: ${role}`);

  const env = { ...baseEnv, ...extraEnv };
  for (const key of ORCHESTRATOR_ONLY_ENV_KEYS) delete env[key];
  if (role === 'implementer') {
    for (const key of IMPLEMENTER_FORBIDDEN_ENV_KEYS) delete env[key];
  }

  return {
    ...env,
    CODEX_HOME: codexHome,
    GH_TOKEN: githubToken,
    GITHUB_TOKEN: githubToken,
    DELIVERY_ROLE: role
  };
}

export class CodexExecutor {
  constructor({ apiKey, authMode = 'chatgpt', model = 'gpt-5.6-sol' }) {
    buildCodexClientOptions({ authMode, apiKey, env: {} });
    this.apiKey = apiKey;
    this.authMode = authMode;
    this.model = model;
  }

  async runFresh({ workingDirectory, codexHome, prompt, outputSchema, role, githubToken, sandboxMode, extraEnv = {} }) {
    const { Codex } = await import('@openai/codex-sdk');
    const env = buildRoleEnvironment({
      baseEnv: process.env,
      extraEnv,
      codexHome,
      githubToken,
      role
    });
    const codex = new Codex(buildCodexClientOptions({
      authMode: this.authMode,
      apiKey: this.apiKey,
      env
    }));
    const thread = codex.startThread({
      workingDirectory,
      model: this.model,
      sandboxMode,
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      skipGitRepoCheck: false
    });
    const result = await thread.run(prompt, { outputSchema });
    const text = result.finalResponse?.trim();
    if (!text) throw new Error(`${role} returned an empty final response`);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new Error(`${role} returned invalid JSON: ${text}`, { cause: error }); }
    return { contextId: thread.id, result: parsed, usage: result.usage ?? null };
  }
}
