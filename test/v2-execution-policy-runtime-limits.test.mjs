import test from 'node:test';
import assert from 'node:assert/strict';

import { executionPolicyFor } from '../src/v2/execution-policy.mjs';

test('risk profiles keep versioned limits without repository variables', () => {
  const fast = executionPolicyFor('fast', {});
  const standard = executionPolicyFor('standard', {});
  const critical = executionPolicyFor('critical', {});

  assert.equal(fast.maxAiCredits, 100);
  assert.equal(fast.maxAiTurns, 20);
  assert.equal(fast.maxImplementationAttempts, 2);

  assert.equal(standard.maxAiCredits, 250);
  assert.equal(standard.maxAiTurns, 40);
  assert.equal(standard.maxImplementationAttempts, 2);

  assert.equal(critical.maxAiCredits, 500);
  assert.equal(critical.maxAiTurns, 80);
  assert.equal(critical.maxImplementationAttempts, 3);
});

test('FAST accepts runtime overrides', () => {
  const policy = executionPolicyFor('fast', {
    DELIVERY_FAST_MAX_AI_CREDITS: '150',
    DELIVERY_FAST_MAX_AI_TURNS: '25',
    DELIVERY_FAST_MAX_IMPLEMENTATION_ATTEMPTS: '3'
  });

  assert.equal(policy.maxAiCredits, 150);
  assert.equal(policy.maxAiTurns, 25);
  assert.equal(policy.maxImplementationAttempts, 3);
});

test('STANDARD accepts runtime overrides', () => {
  const policy = executionPolicyFor('standard', {
    DELIVERY_STANDARD_MAX_AI_CREDITS: '300',
    DELIVERY_STANDARD_MAX_AI_TURNS: '40',
    DELIVERY_STANDARD_MAX_IMPLEMENTATION_ATTEMPTS: '3'
  });

  assert.equal(policy.maxAiCredits, 300);
  assert.equal(policy.maxAiTurns, 40);
  assert.equal(policy.maxImplementationAttempts, 3);
});

test('CRITICAL accepts runtime overrides', () => {
  const policy = executionPolicyFor('critical', {
    DELIVERY_CRITICAL_MAX_AI_CREDITS: '750',
    DELIVERY_CRITICAL_MAX_AI_TURNS: '100',
    DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS: '4'
  });

  assert.equal(policy.maxAiCredits, 750);
  assert.equal(policy.maxAiTurns, 100);
  assert.equal(policy.maxImplementationAttempts, 4);
});

test('invalid runtime limits fail closed', () => {
  assert.throws(
    () =>
      executionPolicyFor('fast', {
        DELIVERY_FAST_MAX_AI_CREDITS: '0'
      }),
    /DELIVERY_FAST_MAX_AI_CREDITS must be a positive integer/
  );

  assert.throws(
    () =>
      executionPolicyFor('standard', {
        DELIVERY_STANDARD_MAX_AI_TURNS: 'abc'
      }),
    /DELIVERY_STANDARD_MAX_AI_TURNS must be a positive integer/
  );

  assert.throws(
    () =>
      executionPolicyFor('critical', {
        DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS: '-1'
      }),
    /DELIVERY_CRITICAL_MAX_IMPLEMENTATION_ATTEMPTS must be a positive integer/
  );
});
