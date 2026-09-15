import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../src/v2/gh-aw-hygiene-artifact.mjs';

test('extracts the final single-line technical hygiene marker from agent log', () => {
  const payload = { reuseDiscovery: [{ symbol: 'x', decision: 'REUSE_EXISTING', evidence: ['path:x'] }], structuralFindings: [], semanticJudgments: [], deterministicReferences: [], missingEvidence: [], semanticCalls: 0 };
  const log = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done\nTECHNICAL_HYGIENE_JSON=' + JSON.stringify(payload) } });
  assert.deepEqual(__test.summaryFromAgentLog(log), payload);
});

test('missing technical hygiene marker fails closed', () => {
  const log = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  assert.throws(() => __test.summaryFromAgentLog(log), /missing TECHNICAL_HYGIENE_JSON/);
});
