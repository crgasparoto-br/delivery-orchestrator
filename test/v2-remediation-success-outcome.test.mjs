import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  classifySuccessfulRemediationOutcome,
  continueAfterSuccessfulRemediation
} from '../scripts/resume-delivery-v2-controller.mjs';

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
  for (const type of ['missing_data', 'noop', 'report_incomplete']) {
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


test('issue 290: no-material outcomes never invoke the material head waiter', async () => {
  for (const type of ['missing_tool', 'missing_data', 'noop', 'report_incomplete']) {
    let waitCalls = 0;
    const result = await continueAfterSuccessfulRemediation({
      evidence: {
        hasPatch: false,
        agentOutput: {
          items: [{ type, reason: 'bounded semantic result' }],
          errors: []
        },
        evidenceRef: `artifact:${type}`
      },
      waitForMaterialHead: async () => {
        waitCalls += 1;
        return { head: { sha: 'should-not-be-used' } };
      }
    });

    assert.equal(waitCalls, 0);
    assert.equal(result.pullRequest, null);
    assert.equal(result.remediationOutcome.action, 'blocked-no-material');
  }
});

test('issue 290: patch evidence invokes the material head waiter exactly once', async () => {
  let waitCalls = 0;
  const expectedPullRequest = { head: { sha: 'b'.repeat(40) } };
  const result = await continueAfterSuccessfulRemediation({
    evidence: {
      hasPatch: true,
      agentOutput: { items: [], errors: [] },
      evidenceRef: 'artifact:patch'
    },
    waitForMaterialHead: async () => {
      waitCalls += 1;
      return expectedPullRequest;
    }
  });

  assert.equal(waitCalls, 1);
  assert.equal(result.pullRequest, expectedPullRequest);
  assert.equal(result.remediationOutcome.action, 'await-material-head');
});

test('issue 290: both remediation entry paths classify evidence before waiting for head drift', async () => {
  const source = await readFile(
    new URL('../scripts/resume-delivery-v2-controller.mjs', import.meta.url),
    'utf8'
  );

  const implementingStart = source.indexOf("if (state.status === 'implementing')");
  const implementingEnd = source.indexOf("if (state.status === 'ci-pending')", implementingStart);
  const implementing = source.slice(implementingStart, implementingEnd);
  assert.match(implementing, /continueAfterSuccessfulRemediation/);
  assert.match(implementing, /runId: run\.id/);
  assert.doesNotMatch(implementing, /runId: worker\.id/);
  assert.doesNotMatch(implementing, /remediationStage\.dispatchNonce/);

  const remediationStart = source.indexOf(
    "if (state.status === 'ci-failed-remediable' || state.status === 'audit-failed-remediable')"
  );
  const remediationEnd = source.indexOf("if (state.status === 'audit-pending')", remediationStart);
  const remediation = source.slice(remediationStart, remediationEnd);
  assert.match(remediation, /runId: worker\.id/);
  assert.match(remediation, /continueAfterSuccessfulRemediation/);
  assert.ok(
    remediation.indexOf('continueAfterSuccessfulRemediation') <
      remediation.indexOf('waitHeadChange')
  );
  assert.match(remediation, /workerDispatchNonce: remediationStage\.dispatchNonce/);
});

test('issue 290: resumed remediation keeps duplicate dispatch protection', async () => {
  const source = await readFile(
    new URL('../scripts/resume-delivery-v2-controller.mjs', import.meta.url),
    'utf8'
  );
  const implementingStart = source.indexOf("if (state.status === 'implementing')");
  const implementingEnd = source.indexOf("if (state.status === 'ci-pending')", implementingStart);
  const implementing = source.slice(implementingStart, implementingEnd);

  assert.match(
    implementing,
    /cannot safely recover in-flight implementation by dispatch nonce; refusing duplicate worker/
  );
  assert.match(implementing, /workerDispatchNonce: controller\.workerDispatchNonce/);
});
