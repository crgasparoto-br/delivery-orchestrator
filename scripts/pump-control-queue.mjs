import { normalizeDeliveryRequest } from '../src/delivery-request.mjs';
import { otherLiveWorkflowRuns, selectOldestQueuedControlIssue } from '../src/control-queue.mjs';

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const currentRunId = Number.parseInt(process.env.GITHUB_RUN_ID ?? '', 10);
const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER || repository?.split('/')[0];
const workflowFile = 'delivery-loop.yml';
const ref = process.env.GITHUB_REF_NAME || 'main';

if (!token || !repository || !Number.isInteger(currentRunId)) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required');

async function github(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

const runsPayload = await github(`/actions/workflows/${workflowFile}/runs?per_page=100`);
const liveRuns = otherLiveWorkflowRuns(runsPayload.workflow_runs ?? [], currentRunId);
if (liveRuns.length > 0) {
  console.log(JSON.stringify({ queue_pump: 'deferred', reason: 'another-live-run', live_runs: liveRuns.map(({ id, status, display_title }) => ({ id, status, display_title })) }, null, 2));
  process.exit(0);
}

const issues = await github('/issues?state=open&per_page=100&sort=created&direction=asc');
const nextIssue = selectOldestQueuedControlIssue(issues);
if (!nextIssue) {
  console.log(JSON.stringify({ queue_pump: 'empty' }, null, 2));
  process.exit(0);
}

const request = normalizeDeliveryRequest({
  eventName: 'issues',
  event: { action: 'opened', sender: { login: nextIssue.user?.login }, issue: nextIssue },
  repositoryOwner,
  allowedActorsText: process.env.DELIVERY_REQUEST_ACTORS,
  allowedRepositoriesText: process.env.DELIVERY_ALLOWED_REPOSITORIES,
  issueMaxCycles: Number(process.env.DELIVERY_REQUEST_MAX_CYCLES || 12)
});

await github(`/actions/workflows/${workflowFile}/dispatches`, {
  method: 'POST',
  body: {
    ref,
    inputs: {
      target_repository: request.targetRepository,
      issue_number: String(request.issueNumber),
      max_cycles: String(request.maxCycles),
      control_issue_number: String(request.controlIssueNumber),
      control_issue_title: String(nextIssue.title)
    }
  }
});

console.log(JSON.stringify({
  queue_pump: 'dispatched',
  control_issue_number: request.controlIssueNumber,
  target_repository: request.targetRepository,
  issue_number: request.issueNumber,
  max_cycles: request.maxCycles
}, null, 2));
