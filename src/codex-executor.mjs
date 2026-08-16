export class CodexExecutor {
  constructor({ apiKey, model = 'gpt-5.6-sol' }) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required');
    this.apiKey = apiKey;
    this.model = model;
  }

  async runFresh({ workingDirectory, codexHome, prompt, outputSchema, role, githubToken, sandboxMode, extraEnv = {} }) {
    const { Codex } = await import('@openai/codex-sdk');
    const env = {
      ...process.env,
      ...extraEnv,
      CODEX_HOME: codexHome,
      GH_TOKEN: githubToken,
      GITHUB_TOKEN: githubToken,
      DELIVERY_ROLE: role
    };
    const codex = new Codex({ apiKey: this.apiKey, env });
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
