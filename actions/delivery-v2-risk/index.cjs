const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function input(name) {
  const canonical = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const underscored = `INPUT_${name.replace(/[- ]/g, '_').toUpperCase()}`;
  return String(process.env[canonical] || process.env[underscored] || '').trim();
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`);
}

function currentPullRequestNumber() {
  const explicit = input('pr-number');
  if (explicit) return Number(explicit);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  return Number(event?.pull_request?.number || 0) || null;
}

async function listChangedPaths({ token, repository, pullRequestNumber }) {
  const [owner, repo] = String(repository || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must use owner/name');
  const changedPaths = [];
  for (let page = 1; page <= 30; page += 1) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'delivery-v2-risk-classifier',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub changed-files request failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const files = await response.json();
    if (!Array.isArray(files)) throw new Error('GitHub changed-files response is not an array');
    for (const file of files) {
      if (file?.filename) changedPaths.push(file.filename);
    }
    if (files.length < 100) return changedPaths;
  }
  throw new Error('Pull request changed-files pagination exceeded 3000 files; fail closed');
}

async function main() {
  const token = input('github-token') || process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const pullRequestNumber = currentPullRequestNumber();
  const requested = input('requested-risk') || 'auto';

  if (!token) throw new Error('github-token is required');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!pullRequestNumber) throw new Error('A pull request number is required');

  const changedPaths = await listChangedPaths({ token, repository, pullRequestNumber });
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../src/v2/ci-plan.mjs')).href;
  const { buildCiPlan } = await import(moduleUrl);
  const plan = buildCiPlan({ requested, changedPaths });

  setOutput('risk-profile', plan.riskProfile);
  setOutput('ci-mode', plan.ciMode);
  setOutput('audit-required', plan.auditRequired);
  setOutput('audit-mode', plan.auditMode);
  setOutput('full-regression-on-pr', plan.fullRegressionOnPr);
  setOutput('full-regression-after-merge', plan.fullRegressionAfterMerge);
  setOutput('promoted', plan.promoted);
  setOutput('changed-paths-json', JSON.stringify(plan.changedPaths));
  setOutput('reasons-json', JSON.stringify(plan.reasons));

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Delivery V2 CI classification\n\n- Requested: \`${plan.requestedRisk}\`\n- Effective: \`${plan.riskProfile}\`\n- CI mode: \`${plan.ciMode}\`\n- Promoted: \`${plan.promoted}\`\n- Changed paths: ${plan.changedPaths.length}\n`
    );
  }
}

main().catch((error) => {
  console.error(`Delivery V2 risk classifier failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
