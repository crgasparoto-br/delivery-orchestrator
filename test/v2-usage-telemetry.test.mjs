import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGhAwUsage, normalizeGhAwUsage, parseGhAwUsageJsonl } from '../src/v2/usage-telemetry.mjs';

test('gh-aw telemetry keeps unavailable token and credit values unknown instead of fabricating zero', () => {
  assert.deepEqual(normalizeGhAwUsage({ provider: 'example', status: 'success' }), {
    turns: null, credits: null, inputTokens: null, outputTokens: null, totalTokens: null
  });
});

test('gh-aw telemetry recognizes common provider usage shapes', () => {
  assert.deepEqual(normalizeGhAwUsage({ usage: { input_tokens: 120, output_tokens: 30, aic: 7, turns: 3 } }), {
    turns: 3, credits: 7, inputTokens: 120, outputTokens: 30, totalTokens: 150
  });
});

test('JSONL normalization uses terminal cumulative counters without double-counting snapshots', () => {
  const usage = parseGhAwUsageJsonl('{"usage":{"input_tokens":10,"output_tokens":2,"aic":1}}\n{"usage":{"input_tokens":30,"output_tokens":8,"aic":3}}\n');
  assert.deepEqual(usage, { turns: null, credits: 3, inputTokens: 30, outputTokens: 8, totalTokens: 38 });
});

test('delivery-level merge sums distinct worker/audit observations but preserves unknowns', () => {
  assert.deepEqual(mergeGhAwUsage([
    { input_tokens: 10, output_tokens: 5, aic: 2, turns: 1 },
    { input_tokens: 20, output_tokens: 10, aic: 3, turns: 2 }
  ]), { turns: 3, credits: 5, inputTokens: 30, outputTokens: 15, totalTokens: 45 });
});
