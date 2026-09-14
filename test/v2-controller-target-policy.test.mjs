import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeControllerTargetPolicy } from '../src/v2/controller-target-policy.mjs';

const base = {
  baseBranch: 'main',
  finalStatusName: 'Delivery V2 release',
  mergePolicy: {
    requiredFinalStatusName: 'Delivery V2 release',
    enforcementMode: 'controller-status-only',
    nativeRequiredStatusEnforced: false,
    limitation: 'Native branch protection is not available to this control plane.'
  }
};

test('controller-only enforcement requires explicit limitation and cannot claim native protection', () => {
  const value = normalizeControllerTargetPolicy('owner/repo', base, { baseBranch: 'main' });
  assert.equal(value.mergePolicy.nativeRequiredStatusEnforced, false);
  assert.throws(() => normalizeControllerTargetPolicy('owner/repo', {
    ...base,
    mergePolicy: { ...base.mergePolicy, limitation: '' }
  }), /requires an explicit enforcement limitation/);
});

test('merge policy must bind the exact final status', () => {
  assert.throws(() => normalizeControllerTargetPolicy('owner/repo', {
    ...base,
    mergePolicy: { ...base.mergePolicy, requiredFinalStatusName: 'Other' }
  }), /must match finalStatusName/);
});
