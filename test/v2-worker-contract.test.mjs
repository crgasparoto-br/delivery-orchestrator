import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const policy = {
  fast: { turns: 20, credits: 100 },
  standard: { turns: 40, credits: 250 },
  critical: { turns: 80, credits: 500 }
};

for (const provider of ['copilot', 'codex', 'claude']) {
  for (const risk of ['fast', 'standard', 'critical']) {
    test(`worker contract ${provider}/${risk}`, async () => {
      const file = `.github/workflows/delivery-v2-worker-${provider}-${risk}.md`;
      const body = await readFile(file, 'utf8');
      assert.match(body, new RegExp(`engine: ${provider}`));
      assert.match(body, new RegExp(`max-turns: ${policy[risk].turns}`));
      assert.match(body, new RegExp(`max-ai-credits: ${policy[risk].credits}`));
      assert.match(body, /github-token: \$\{\{ secrets\.DELIVERY_GITHUB_READ_TOKEN \}\}/);
      assert.match(body, /safe-outputs:[\s\S]*github-token: \$\{\{ secrets\.DELIVERY_GITHUB_WRITE_TOKEN \}\}/);
      assert.match(body, /create-pull-request:/);
      assert.doesNotMatch(body, /merge-pull-request:/);
      assert.doesNotMatch(body, /entregar-issue|auditar-issue/i);
      assert.doesNotMatch(body, /permissions:[\s\S]{0,200}contents: write/);
      if (risk === 'fast') assert.match(body, /allowed-files:/);
      else assert.doesNotMatch(body, /allowed-files:/);
    });
  }
}
