import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySuccessfulRemediationOutcome } from '../scripts/resume-delivery-v2-controller.mjs';

test('issue 290: successful remediation with a patch still requires a new material head', () => {
  assert.deepEqual(
    classifySuccessfulRemediationOutcome({
      hasPatch: true,
      agentOutput: { items: [], errors: [] },
      evidenceRef: 'artifact:patch'
    }),
    {
      action: 'await-material-head',
      classification: 'patch-produced',
      reason: 'remediation artifact contains a material patch',
      evidenceRef: 'artifact:patch'
    }
  );
});

test('issue 290: real missing_tool no-patch output blocks immediately instead of waiting for head drift', () => {
  const result = classifySuccessfulRemediationOutcome({
    hasPatch: false,
    evidenceRef: 'artifact:36484147713',
    agentOutput: {
      items: [{
        type: 'missing_tool',
        tool: 'gh and executable project validation toolchain',
        reason: 'Cannot retrieve the cited actionable CI failure without guessing.'
      }],
      errors: []
    }
  });

  assert.equal(result.action, 'blocked-no-material');
  assert.equal(result.classification, 'no-material-missing_tool');
  assert.equal(result.tool, 'gh and executable project validation toolchain');
  assert.equal(result.evidenceRef, 'artifact:36484147713');
  assert.match(result.reason, /without guessing/);
});

test('issue 290: no-patch semantic safe outputs are bounded and explicit', () => {
  for (const type of ['missing_data', 'noop']) {
    const result = classifySuccessfulRemediationOutcome({
      hasPatch: false,
      agentOutput: { items: [{ type, reason: 'bounded semantic result' }], errors: [] }
    });
    assert.equal(result.action, 'blocked-no-material');
    assert.equal(result.classification, `no-material-${type}`);
  }
});

test('issue 290: ambiguous successful remediation evidence fails closed', () => {
  assert.equal(
    classifySuccessfulRemediationOutcome({
      hasPatch: null,
      agentOutput: null,
      artifactError: 'agent artifact unavailable'
    }).action,
    'fail-closed'
  );

  assert.equal(
    classifySuccessfulRemediationOutcome({
      hasPatch: false,
      agentOutput: { items: [], errors: [] }
    }).classification,
    'no-patch-output-ambiguous'
  );

  assert.equal(
    classifySuccessfulRemediationOutcome({
      hasPatch: false,
      agentOutput: { items: [{ type: 'push_to_pull_request_branch' }], errors: [] }
    }).classification,
    'no-patch-output-unsupported'
  );

  assert.equal(
    classifySuccessfulRemediationOutcome({
      hasPatch: false,
      agentOutput: { items: [{ type: 'missing_tool' }], errors: ['framework error'] }
    }).classification,
    'no-patch-output-ambiguous'
  );
});
