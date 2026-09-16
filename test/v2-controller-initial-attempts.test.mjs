import assert from 'node:assert/strict';
import test from 'node:test';

import { nonNegativeInteger } from '../scripts/run-delivery-v2-controller.mjs';

test('scope discovery accepts zero initial material attempts', () => {
  assert.equal(nonNegativeInteger('0', 'DELIVERY_V2_INITIAL_ATTEMPTS'), 0);
});

test('initial attempt counter rejects invalid pre-dispatch values', () => {
  for (const value of ['-1', '0.5', 'not-a-number', '']) {
    assert.throws(
      () => nonNegativeInteger(value, 'DELIVERY_V2_INITIAL_ATTEMPTS'),
      /DELIVERY_V2_INITIAL_ATTEMPTS must be a non-negative integer/
    );
  }
});
