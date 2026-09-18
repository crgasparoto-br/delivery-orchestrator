import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTransientFetchFailure,
  withTransientFetchRetry
} from '../src/v2/github-api-retry.mjs';

test('transient fetch failures retry twice with bounded observable backoff', async () => {
  let calls = 0;
  const delays = [];
  const warnings = [];

  const result = await withTransientFetchRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return 'ok';
    },
    {
      label: 'test GitHub request',
      baseDelayMs: 10,
      sleepFn: async (ms) => delays.push(ms),
      warn: (message) => warnings.push(message)
    }
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /attempt 1\/3/);
  assert.match(warnings[1], /attempt 2\/3/);
  assert.equal(isTransientFetchFailure(new TypeError('fetch failed')), true);
});

test('HTTP and other non-fetch failures remain fail-closed without retry', async () => {
  for (const error of [
    new Error('GitHub API 503 GET https://api.github.com/test'),
    new TypeError('unexpected protocol failure')
  ]) {
    let calls = 0;
    let retries = 0;

    await assert.rejects(
      withTransientFetchRetry(
        async () => {
          calls += 1;
          throw error;
        },
        {
          sleepFn: async () => {
            retries += 1;
          },
          warn: () => {
            retries += 1;
          }
        }
      ),
      error
    );

    assert.equal(calls, 1);
    assert.equal(retries, 0);
  }
});
