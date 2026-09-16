import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../src/v2/gh-aw-hygiene-artifact.mjs';
import { evaluateTechnicalHygiene } from '../src/v2/technical-hygiene.mjs';

test('extracts the final single-line technical hygiene marker from agent log', () => {
  const payload = { reuseDiscovery: [{ symbol: 'x', decision: 'REUSE_EXISTING', evidence: ['path:x'] }], structuralFindings: [], semanticJudgments: [], deterministicReferences: [], missingEvidence: [], semanticCalls: 0 };
  const log = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done\nTECHNICAL_HYGIENE_JSON=' + JSON.stringify(payload) } });
  assert.deepEqual(__test.summaryFromAgentLog(log), payload);
});

test('normalizes shorthand hygiene payload emitted by implementation worker', () => {
  const normalized = __test.normalizeWorkerSummary({ reuseDiscovery: 'REUSE_EXISTING', createdFiles: [], structuralFindings: [], semanticJudgments: [], deterministicReferences: ['src/v2/gh-aw-hygiene-artifact.mjs:normalizeWorkerSummary'], missingEvidence: [], semanticCalls: ['bounded symbolic search'] });
  assert.deepEqual(normalized.reuseDiscovery, [{ symbol: 'worker-scope', decision: 'REUSE_EXISTING', evidence: ['src/v2/gh-aw-hygiene-artifact.mjs:normalizeWorkerSummary'] }]);
  assert.deepEqual(normalized.deterministicReferences, [{ symbol: 'src/v2/gh-aw-hygiene-artifact.mjs:normalizeWorkerSummary', referenced: true, evidence: ['src/v2/gh-aw-hygiene-artifact.mjs:normalizeWorkerSummary'] }]);
  assert.equal(normalized.semanticCalls, 1);
});

test('observed issue 105 worker shorthand normalizes into an evaluable evidence-preserving hygiene payload', () => {
  const normalized = __test.normalizeWorkerSummary({
    reuseDiscovery: 'EXTEND_EXISTING',
    createdFiles: [],
    structuralFindings: [],
    semanticJudgments: [{
      decision: 'Extended existing re-entry guard and persistent-state ownership',
      evidence: [
        'scripts/guard-delivery-v2-reentry.mjs:47',
        'src/v2/persistent-state.mjs:189',
        'scripts/resume-delivery-v2-controller.mjs:380'
      ]
    }],
    deterministicReferences: [
      'test/v2-reentry-guard.test.mjs:132',
      'scripts/guard-delivery-v2-reentry.mjs:64'
    ],
    missingEvidence: [],
    semanticCalls: [
      'Legacy adoption requires an open same-repository PR, explicit closing relationship, expected base, trusted ownership, and unique candidacy.'
    ]
  });

  const evaluated = evaluateTechnicalHygiene({
    schemaVersion: 1,
    profile: 'critical',
    baselineSha: 'a'.repeat(40),
    materialSha: 'b'.repeat(40),
    previousMaterialSha: null,
    ...normalized,
    evidenceRef: 'artifact://issue-105-worker'
  });

  assert.equal(evaluated.result, 'PASS');
  assert.equal(evaluated.semanticCalls, 1);
  assert.deepEqual(evaluated.extendedSymbols, ['worker-scope']);
  assert.deepEqual(evaluated.missingEvidence, []);
});

test('shorthand reuse decision without deterministic evidence fails closed', () => {
  assert.throws(() => __test.normalizeWorkerSummary({ reuseDiscovery: 'REUSE_EXISTING', deterministicReferences: [], semanticCalls: 0 }), /requires deterministicReferences evidence/);
});

test('unsupported shorthand reuse decision fails closed', () => {
  assert.throws(() => __test.normalizeWorkerSummary({ reuseDiscovery: 'MAGIC_REUSE', deterministicReferences: ['path:x'], semanticCalls: 0 }), /unsupported shorthand reuse decision/);
});

test('missing technical hygiene marker fails closed', () => {
  const log = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  assert.throws(() => __test.summaryFromAgentLog(log), /missing TECHNICAL_HYGIENE_JSON/);
});
