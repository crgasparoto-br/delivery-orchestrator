import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAiBudgetWarnings } from '../src/v2/ai-budget.mjs';

function report({
  effectiveCost = null,
  currency = 'USD',
  unknownCostEntries = 0,
  accounting = 'complete'
} = {}) {
  const costByCurrency = {};

  if (effectiveCost != null) {
    costByCurrency[currency] = {
      reportedCost: effectiveCost,
      estimatedCost: 0,
      effectiveCost,
      accounting: 'complete'
    };
  }

  return {
    totals: {
      costByCurrency,
      unknownCostEntries,
      accounting,
      remediationRuns: 0,
      attempts: {
        remediation: {
          total: 0,
          unknownEntries: 0,
          accounting: 'complete'
        }
      }
    },
    groups: {}
  };
}

const budget = {
  monthly: {
    amount: 250,
    currency: 'USD'
  }
};

test('F-214-06: known spend below budget plus unknown costs is explicitly inconclusive', () => {
  const result = evaluateAiBudgetWarnings(
    report({
      effectiveCost: 100,
      unknownCostEntries: 1,
      accounting: 'partial'
    }),
    budget
  );

  assert.equal(result.blocking, false);

  assert.equal(
    result.warnings.some((warning) => warning.type === 'monthly-budget-exceeded'),
    false
  );

  const warning = result.warnings.find(
    (item) => item.type === 'monthly-budget-inconclusive'
  );

  assert.ok(warning);
  assert.equal(warning.currency, 'USD');
  assert.equal(warning.spent, 100);
  assert.equal(warning.limit, 250);
  assert.equal(warning.unknownCostEntries, 1);
  assert.equal(warning.accounting, 'partial');
});

test('F-214-06: unknown-only spend cannot be interpreted as unused budget', () => {
  const result = evaluateAiBudgetWarnings(
    report({
      effectiveCost: null,
      unknownCostEntries: 2,
      accounting: 'partial'
    }),
    budget
  );

  assert.equal(result.blocking, false);

  const warning = result.warnings.find(
    (item) => item.type === 'monthly-budget-inconclusive'
  );

  assert.ok(warning);
  assert.equal(warning.spent, null);
  assert.equal(warning.limit, 250);
  assert.equal(warning.unknownCostEntries, 2);
});

test('F-214-06: known spend above budget remains conclusively exceeded despite unknown costs', () => {
  const result = evaluateAiBudgetWarnings(
    report({
      effectiveCost: 300,
      unknownCostEntries: 1,
      accounting: 'partial'
    }),
    budget
  );

  assert.equal(result.blocking, false);

  const exceeded = result.warnings.find(
    (item) => item.type === 'monthly-budget-exceeded'
  );

  assert.ok(exceeded);
  assert.equal(exceeded.spent, 300);
  assert.equal(exceeded.limit, 250);
  assert.equal(exceeded.unknownCostEntries, 1);

  assert.equal(
    result.warnings.some(
      (item) => item.type === 'monthly-budget-inconclusive'
    ),
    false
  );
});

test('F-214-06: complete known spend below budget needs no budget warning', () => {
  const result = evaluateAiBudgetWarnings(
    report({
      effectiveCost: 100,
      unknownCostEntries: 0,
      accounting: 'complete'
    }),
    budget
  );

  assert.equal(result.blocking, false);
  assert.equal(
    result.warnings.some(
      (item) =>
        item.type === 'monthly-budget-exceeded' ||
        item.type === 'monthly-budget-inconclusive'
    ),
    false
  );
});
