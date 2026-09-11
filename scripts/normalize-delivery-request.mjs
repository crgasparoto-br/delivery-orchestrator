import { appendFile, readFile } from 'node:fs/promises';
import { normalizeDeliveryRequest } from '../src/delivery-request.mjs';

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');

const event = JSON.parse(await readFile(eventPath, 'utf8'));
const request = normalizeDeliveryRequest({
  eventName: process.env.GITHUB_EVENT_NAME,
  event,
  manualInputs: {
    targetRepository: process.env.MANUAL_TARGET_REPOSITORY,
    issueNumber: process.env.MANUAL_ISSUE_NUMBER,
    maxCycles: process.env.MANUAL_MAX_CYCLES,
    controlIssueNumber: process.env.MANUAL_CONTROL_ISSUE_NUMBER
  },
  repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER,
  allowedActorsText: process.env.DELIVERY_REQUEST_ACTORS,
  allowedRepositoriesText: process.env.DELIVERY_ALLOWED_REPOSITORIES,
  issueMaxCycles: Number(process.env.DELIVERY_REQUEST_MAX_CYCLES || 12)
});

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error('GITHUB_OUTPUT is required');

const outputs = {
  source: request.source,
  target_repository: request.targetRepository,
  issue_number: String(request.issueNumber),
  max_cycles: String(request.maxCycles),
  control_issue_number: request.controlIssueNumber ? String(request.controlIssueNumber) : ''
};

await appendFile(
  outputPath,
  `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  'utf8'
);

console.log(JSON.stringify({
  source: request.source,
  target_repository: request.targetRepository,
  issue_number: request.issueNumber,
  max_cycles: request.maxCycles,
  control_issue_number: request.controlIssueNumber
}, null, 2));
