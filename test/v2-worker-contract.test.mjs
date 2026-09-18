import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const policy = {
  fast: { turns: 20, credits: 100 },
  standard: { turns: 40, credits: 250 },
  critical: { turns: 80, credits: 500 }
};

function usageArtifactUploadBlock(lockBody) {
  const usageNameIndex = lockBody.indexOf('\n          name: usage\n');
  assert.notEqual(usageNameIndex, -1, 'compiled worker must define the usage artifact');
  const stepStart = lockBody.lastIndexOf('\n      - name:', usageNameIndex);
  assert.notEqual(stepStart, -1, 'usage artifact must belong to a workflow step');
  const nextStep = lockBody.indexOf('\n      - name:', usageNameIndex);
  const block = lockBody.slice(stepStart, nextStep === -1 ? lockBody.length : nextStep);
  assert.match(block, /uses: actions\/upload-artifact@/);
  assert.match(block, /with:\s*\n\s+name: usage\s*\n\s+path: \|/);
  return block;
}

for (const provider of ['copilot', 'codex', 'claude']) {
  for (const risk of ['fast', 'standard', 'critical']) {
    test(`worker contract ${provider}/${risk}`, async () => {
      const file = `.github/workflows/delivery-v2-worker-${provider}-${risk}.md`;
      const lockFile = `.github/workflows/delivery-v2-worker-${provider}-${risk}.lock.yml`;
      const body = await readFile(file, 'utf8');
      const lockBody = await readFile(lockFile, 'utf8');
      assert.match(body, new RegExp(`engine:\\s*\\n\\s+id: ${provider}`));

      const prefix = risk.toUpperCase();

      assert.match(
        body,
        new RegExp(
          `max-turns:\\s*\\$\\{\\{\\s*vars\\.DELIVERY_${prefix}_MAX_AI_TURNS\\s*\\|\\|\\s*'${policy[risk].turns}'\\s*\\}\\}`
        )
      );

      assert.match(
        body,
        new RegExp(
          `GH_AW_MAX_AI_CREDITS:\\s*\\$\\{\\{\\s*vars\\.DELIVERY_${prefix}_MAX_AI_CREDITS\\s*\\|\\|\\s*'${policy[risk].credits}'\\s*\\}\\}`
        )
      );

      assert.doesNotMatch(
        body,
        /^max-ai-credits:/m,
        'AI credits must be supplied through engine.env for runtime configurability'
      );

      assert.match(
        lockBody,
        new RegExp(`DELIVERY_${prefix}_MAX_AI_TURNS`)
      );

      assert.match(
        lockBody,
        new RegExp(`DELIVERY_${prefix}_MAX_AI_CREDITS`)
      );
      assert.match(body, /target_ref:/);
      assert.match(body, /target_pr:/);
      assert.match(body, /remediation_context:/);
      assert.match(body, /dispatch_nonce:/);
      assert.match(body, /run-name: "Delivery V2 worker \$\{\{ github\.event\.inputs\.dispatch_nonce \}\}"/);
      assert.match(body, /fetch: \["refs\/pulls\/open\/\*"\]/);
      assert.match(body, /github-token: \$\{\{ secrets\.DELIVERY_GITHUB_READ_TOKEN \}\}/);
      assert.match(body, /safe-outputs:[\s\S]*github-token: \$\{\{ secrets\.DELIVERY_GITHUB_WRITE_TOKEN \}\}/);
      assert.match(body, /GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST: "\$\{\{ github\.event\.inputs\.target_pr == '' && 'true' \|\| 'false' \}\}"/);
      assert.match(body, /create-pull-request:/);
      assert.match(body, /title-prefix: "\[delivery-v2\] "/);
      assert.match(body, /push-to-pull-request-branch:/);
      assert.match(body, /target: "\$\{\{ github\.event\.inputs\.target_pr \}\}"/);
      assert.doesNotMatch(body, /target: "\*"/);
      assert.match(body, /required-title-prefix: "\[delivery-v2\] "/);
      assert.match(body, /fallback-as-pull-request: false/);
      assert.match(body, /Remediation mode/);
      assert.match(body, /Do \*\*not\*\* create a replacement PR/);
      assert.match(lockBody, /GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST/);
      assert.doesNotMatch(body, /merge-pull-request:/);
      assert.doesNotMatch(body, /entregar-issue|auditar-issue/i);
      assert.doesNotMatch(body, /permissions:[\s\S]{0,200}contents: write/);
      assert.match(body, /Context hygiene:/);
      assert.doesNotMatch(body, /\.audit\/\*\*|skills\/catalog\/\*\*/);
      assert.match(body, /retired or generated delivery snapshots/);
      assert.match(body, /\.generated\/\*\*/);
      assert.match(body, /compiled `\*\.lock\.yml`/);
      assert.match(body, /issue-relevant source\/test\/docs paths/);
      const usageUpload = usageArtifactUploadBlock(lockBody);
      assert.match(usageUpload, /\/tmp\/gh-aw\/usage\/agent_usage\.json(?:\n|$)/);
      assert.match(usageUpload, /\/tmp\/gh-aw\/usage\/agent_usage\.jsonl(?:\n|$)/);
      if (risk === 'fast') {
        const allowedFilesCount = (body.match(/allowed-files:/g) ?? []).length;
        assert.equal(allowedFilesCount, 2, 'FAST must constrain both create-PR and remediation-push outputs');
      } else {
        assert.doesNotMatch(body, /allowed-files:/);
      }
    });
  }
}

test('gh-aw compiler verifies canonical locks without repository writes, storage artifacts or duplicate snapshots', async () => {
  const body = await readFile('.github/workflows/delivery-v2-gh-aw-compile.yml', 'utf8');
  assert.match(body, /permissions:\n  contents: read/);
  assert.match(body, /gh aw compile --strict/);
  assert.match(body, /git diff --exit-code -- \.github\/workflows\/delivery-v2-worker-\*\.lock\.yml \.github\/aw\/actions-lock\.json/);
  assert.doesNotMatch(body, /actions\/upload-artifact|git push|contents: write|DELIVERY_GITHUB_WRITE_TOKEN/);
  assert.doesNotMatch(body, /\.generated\/gh-aw/);
});

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

test('duplicate compiled worker snapshot directory stays absent', async () => {
  assert.equal(await exists('.generated/gh-aw'), false);
});
