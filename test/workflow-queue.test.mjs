import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeDeliveryRequest } from '../src/delivery-request.mjs';

const workflowUrl = new URL('../.github/workflows/delivery-loop.yml', import.meta.url);
const promptUrl = new URL('../prompts/implementer.md', import.meta.url);

test('workflow uses durable control issues and pumps the next queued request', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /MANUAL_CONTROL_ISSUE_NUMBER/);
  assert.match(workflow, /Finalize persistent queue item/);
  assert.match(workflow, /Pump persistent delivery queue/);
  assert.match(workflow, /node scripts\/pump-control-queue\.mjs/);
  assert.match(workflow, /continue-on-error: true/);
});

test('queue workflow_dispatch preserves the original control issue identity', () => {
  const request = normalizeDeliveryRequest({
    eventName: 'workflow_dispatch',
    event: {},
    manualInputs: {
      targetRepository: 'crgasparoto-br/controle_calorias',
      issueNumber: '1057',
      maxCycles: '6',
      controlIssueNumber: '15'
    },
    repositoryOwner: 'crgasparoto-br'
  });
  assert.equal(request.source, 'control_queue');
  assert.equal(request.controlIssueNumber, 15);
});

test('workflow resolves and propagates an existing PR binding', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /Resolve reusable pull request/);
  assert.match(workflow, /BOUND_PULL_REQUEST/);
  assert.match(workflow, /BOUND_HEAD_REF/);
  assert.match(workflow, /REUSE_EXISTING_PR/);
});

test('implementer prompt forbids replacement PRs when a canonical PR exists', async () => {
  const prompt = await readFile(promptUrl, 'utf8');
  assert.match(prompt, /reuse_existing_pr=\{\{reuse_existing_pr\}\}/);
  assert.match(prompt, /Never create a replacement branch or another PR for the issue/);
});
