import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

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
      assert.match(body, /Context hygiene:/);
      assert.match(body, /\.audit\/\*\*/);
      assert.match(body, /skills\/catalog\/\*\*/);
      assert.match(body, /\.generated\/\*\*/);
      assert.match(body, /compiled `\*\.lock\.yml`/);
      assert.match(body, /issue-relevant source\/test\/docs paths/);
      if (risk === 'fast') assert.match(body, /allowed-files:/);
      else assert.doesNotMatch(body, /allowed-files:/);
    });
  }
}

test('gh-aw compiler publishes canonical worker locks without duplicate generated snapshots', async () => {
  const body = await readFile('.github/workflows/delivery-v2-gh-aw-compile.yml', 'utf8');
  assert.match(body, /git add \.github\/workflows\/delivery-v2-worker-\*\.lock\.yml \.github\/aw\/actions-lock\.json/);
  assert.doesNotMatch(body, /\.generated\/gh-aw/);
});

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

test('duplicate compiled worker snapshot directory stays absent', async () => {
  assert.equal(await exists('.generated/gh-aw'), false);
});
