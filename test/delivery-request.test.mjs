import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeliveryRequest } from '../src/delivery-request.mjs';

const owner = 'crgasparoto-br';

function issueEvent({
  actor = owner,
  title = 'delivery-request: crgasparoto-br/controle_calorias#987',
  body = JSON.stringify({ target_repository: 'crgasparoto-br/controle_calorias', issue_number: 987, max_cycles: 6 }),
  number = 12
} = {}) {
  return {
    action: 'opened',
    sender: { login: actor },
    issue: { number, title, body, user: { login: actor } }
  };
}

test('normalizes manual workflow inputs without applying control-issue allowlists', () => {
  const request = normalizeDeliveryRequest({
    eventName: 'workflow_dispatch',
    event: {},
    manualInputs: { targetRepository: 'external/repo', issueNumber: '987', maxCycles: '6' },
    repositoryOwner: owner
  });
  assert.deepEqual(request, {
    source: 'workflow_dispatch',
    targetRepository: 'external/repo',
    issueNumber: 987,
    maxCycles: 6,
    controlIssueNumber: null
  });
});

test('accepts an owner control issue targeting an owner repository', () => {
  const request = normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent(),
    repositoryOwner: owner
  });
  assert.equal(request.source, 'control_issue');
  assert.equal(request.targetRepository, 'crgasparoto-br/controle_calorias');
  assert.equal(request.issueNumber, 987);
  assert.equal(request.maxCycles, 6);
  assert.equal(request.controlIssueNumber, 12);
});

test('rejects control issues from actors outside the allowlist', () => {
  assert.throws(() => normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent({ actor: 'mallory' }),
    repositoryOwner: owner
  }), /not allowed to request deliveries/);
});

test('rejects external target repositories by default', () => {
  const body = JSON.stringify({ target_repository: 'external/repo', issue_number: 987, max_cycles: 6 });
  assert.throws(() => normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent({ body }),
    repositoryOwner: owner
  }), /target repository external\/repo is not allowed/);
});

test('accepts explicitly allowlisted repositories and actors', () => {
  const body = JSON.stringify({ target_repository: 'external/repo', issue_number: 987, max_cycles: 4 });
  const request = normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent({ actor: 'delivery-bot', body }),
    repositoryOwner: owner,
    allowedActorsText: 'crgasparoto-br, delivery-bot',
    allowedRepositoriesText: 'crgasparoto-br/*, external/repo'
  });
  assert.equal(request.targetRepository, 'external/repo');
  assert.equal(request.maxCycles, 4);
});

test('rejects unsupported fields in control issue payloads', () => {
  const body = JSON.stringify({
    target_repository: 'crgasparoto-br/controle_calorias',
    issue_number: 987,
    max_cycles: 6,
    command: 'arbitrary shell'
  });
  assert.throws(() => normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent({ body }),
    repositoryOwner: owner
  }), /unsupported delivery request fields: command/);
});

test('limits control issue max_cycles', () => {
  const body = JSON.stringify({ target_repository: 'crgasparoto-br/controle_calorias', issue_number: 987, max_cycles: 13 });
  assert.throws(() => normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent({ body }),
    repositoryOwner: owner
  }), /max_cycles must be >= 1 and <= 12/);
});

test('fails closed when the configured control issue cycle limit is invalid', () => {
  assert.throws(() => normalizeDeliveryRequest({
    eventName: 'issues',
    event: issueEvent(),
    repositoryOwner: owner,
    issueMaxCycles: Number.NaN
  }), /DELIVERY_REQUEST_MAX_CYCLES must be an integer/);
});
