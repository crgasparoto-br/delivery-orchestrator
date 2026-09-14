import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const defaults = Object.freeze({
  codex: 'gpt-5.4',
  claude: 'claude-sonnet-5',
  copilot: 'gpt-5.3-codex'
});

for (const provider of ['codex', 'claude', 'copilot']) {
  for (const risk of ['fast', 'standard', 'critical']) {
    test(`${provider}/${risk} worker model is GitHub-variable controlled with concrete default`, async () => {
      const file = new URL(`../.github/workflows/delivery-v2-worker-${provider}-${risk}.md`, import.meta.url);
      const source = await readFile(file, 'utf8');
      const riskVar = `DELIVERY_${risk.toUpperCase()}_IMPLEMENTER_MODEL`;
      assert.match(source, new RegExp(`id: ${provider}`));
      assert.match(source, new RegExp(`vars\\.${riskVar}`));
      assert.match(source, /vars\.DELIVERY_IMPLEMENTER_MODEL/);
      assert.ok(source.includes(`|| '${defaults[provider]}'`), `expected concrete ${provider} fallback`);
      assert.ok(!source.includes("|| 'auto'"), 'auto model fallback must not be used');
      assert.ok(!source.includes("|| 'agent'"), 'agent model fallback must not be used');
    });
  }
}
