#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { decideControllerContinuation } from '../src/v2/controller-continuity.mjs';
import { parseTrustedJsonEnvelope, trustedCommentAuthorForRepository } from '../src/v2/controller-provenance.mjs';
import { githubApi, listAllGithub } from '../src/v2/controller-github-api.mjs';

const STATE_MARKER = '<!-- delivery-v2-state -->';
const CONTINUATION_MARKER = '<!-- delivery-v2-continuation -->';

function requiredString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}
function positiveInteger(value, label) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
}
function managedPullRequest(pulls, { issueNumber, baseBranch, trustedLogin }) {
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
  const candidates = pulls.filter((pr) =>
    pr.state === 'open' &&
    pr.base?.ref === baseBranch &&
    String(pr.title ?? '').startsWith('[delivery-v2] ') &&
    closing.test(String(pr.body ?? '')) &&
    String(pr.user?.login ?? '').toLowerCase() === trustedLogin
  );
  if (candidates.length > 1) throw new Error(`multiple Delivery V2 PRs found for issue #${issueNumber}`);
  return candidates[0] ?? null;
}
async function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(outputPath, `${name}=${value}\n`, 'utf8');
}

export async function main() {
  const controllerOutcome = String(process.env.DELIVERY_V2_CONTROLLER_OUTCOME ?? '').trim().toLowerCase();
  if (controllerOutcome !== 'failure') {
    await setOutput('scheduled', 'false');
    return;
  }

  const targetRepository = requiredString(process.env.TARGET_REPOSITORY, 'TARGET_REPOSITORY');
  const issueNumber = positiveInteger(process.env.TARGET_ISSUE, 'TARGET_ISSUE');
  const baseBranch = requiredString(process.env.BASE_BRANCH, 'BASE_BRANCH');
  const riskProfile = requiredString(process.env.DELIVERY_RISK_PROFILE, 'DELIVERY_RISK_PROFILE');
  const changedPaths = String(process.env.DELIVERY_CHANGED_PATHS ?? '');
  const orchestratorRepository = requiredString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const orchestratorRef = requiredString(process.env.GITHUB_REF_NAME || process.env.ORCHESTRATOR_WORKER_REF, 'orchestrator ref');
  const readToken = requiredString(process.env.DELIVERY_GITHUB_READ_TOKEN, 'DELIVERY_GITHUB_READ_TOKEN');
  const writeToken = requiredString(process.env.DELIVERY_GITHUB_WRITE_TOKEN, 'DELIVERY_GITHUB_WRITE_TOKEN');
  const actionsToken = requiredString(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN');

  const pulls = await listAllGithub(`https://api.github.com/repos/${targetRepository}/pulls?state=open&base=${encodeURIComponent(baseBranch)}`, readToken);
  const trustedLogin = trustedCommentAuthorForRepository(targetRepository);
  const pr = managedPullRequest(pulls, { issueNumber, baseBranch, trustedLogin });
  if (!pr) {
    await setOutput('scheduled', 'false');
    return;
  }

  const comments = await listAllGithub(`https://api.github.com/repos/${targetRepository}/issues/${pr.number}/comments`, readToken);
  const envelope = parseTrustedJsonEnvelope(comments, {
    marker: STATE_MARKER,
    label: 'Delivery V2 state',
    trustedLogin
  });
  if (!envelope?.value?.persistent || !envelope?.value?.controller) {
    await setOutput('scheduled', 'false');
    return;
  }

  const { persistent, controller } = envelope.value;
  const checkpoint = controller.waitCheckpoint ?? {
    schemaVersion: 1,
    repository: persistent.repository,
    issueNumber: persistent.issueNumber,
    pullRequestNumber: persistent.pullRequestNumber,
    branch: persistent.headRef,
    materialHeadSha: persistent.materialHeadSha,
    owner: 'delivery-v2-controller',
    nextPhase: controller.nextAction,
    freezeState: 'operational-state-persisted',
    handoffState: 'not-applicable-native-delivery-v2',
    lastEvidenceRef: persistent.evidenceRefs?.at?.(-1) ?? null,
    recordedAt: new Date().toISOString()
  };

  const fingerprint = [
    checkpoint.repository,
    checkpoint.issueNumber,
    checkpoint.pullRequestNumber,
    checkpoint.materialHeadSha,
    checkpoint.nextPhase
  ].join(':');
  const previousContinuationCount =
    controller.continuationFingerprint === fingerprint
      ? Number(controller.continuationCount ?? 0)
      : 0;
  const decision = decideControllerContinuation({
    controllerOutcome,
    stateStatus: persistent.status,
    nextAction: controller.nextAction,
    checkpoint,
    previousContinuationCount,
    maxContinuations: Number(process.env.DELIVERY_V2_MAX_CONTINUATIONS || 3)
  });

  if (decision.action !== 'dispatch-resume') {
    await setOutput('scheduled', 'false');
    await setOutput('reason', decision.reason);
    return;
  }

  const reservedController = {
    ...controller,
    continuationFingerprint: decision.fingerprint,
    continuationCount: decision.nextContinuationCount,
    continuationReservedByRunId: Number(process.env.GITHUB_RUN_ID)
  };
  const reservedStateBody = `${STATE_MARKER}
## Delivery V2 controller state

\`\`\`json
${JSON.stringify({ persistent, controller: reservedController }, null, 2)}
\`\`\``;
  await githubApi(`https://api.github.com/repos/${targetRepository}/issues/comments/${envelope.commentId}`, writeToken, {
    userAgent: 'delivery-v2-continuation',
    method: 'PATCH',
    body: JSON.stringify({ body: reservedStateBody })
  });

  await githubApi(`https://api.github.com/repos/${orchestratorRepository}/actions/workflows/delivery-v2-dispatch.yml/dispatches`, actionsToken, {
    userAgent: 'delivery-v2-continuation',
    method: 'POST',
    body: JSON.stringify({
      ref: orchestratorRef,
      inputs: {
        target_repository: targetRepository,
        target_issue: String(issueNumber),
        risk_profile: riskProfile,
        base_branch: baseBranch,
        changed_paths: changedPaths
      }
    })
  });

  const body = `${CONTINUATION_MARKER}
## Delivery V2 resilient continuation

A controller interruption was recovered from a persisted checkpoint.

- fingerprint: \`${decision.fingerprint}\`
- nextPhase: \`${decision.nextPhase}\`
- continuationCount: ${decision.nextContinuationCount}
- materialHeadSha: \`${checkpoint.materialHeadSha}\`
- previousRun: https://github.com/${orchestratorRepository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  await githubApi(`https://api.github.com/repos/${targetRepository}/issues/${pr.number}/comments`, writeToken, {
    userAgent: 'delivery-v2-continuation',
    method: 'POST',
    body: JSON.stringify({ body })
  });

  process.stdout.write(`[delivery-v2] resilient continuation scheduled pr=${pr.number} phase=${decision.nextPhase} count=${decision.nextContinuationCount}\n`);
  await setOutput('scheduled', 'true');
  await setOutput('reason', decision.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
