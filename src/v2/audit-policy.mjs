import { readFileSync } from 'node:fs';

import { executionPolicyFor } from './execution-policy.mjs';

const CONTROLLER_TARGETS = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../config/delivery-v2-controller-targets.json', import.meta.url), 'utf8')).targets ?? {};
  } catch {
    return {};
  }
})();

export function standardAuditRequiredFor({ repository, standardAuditRequired } = {}) {
  if (typeof standardAuditRequired === 'boolean') return standardAuditRequired;
  const target = CONTROLLER_TARGETS[String(repository ?? '').trim()];
  return target?.standardAuditRequired !== false;
}

export function resolveOperationalAuditPolicy({ riskProfile, repository, standardAuditRequired } = {}) {
  const policy = executionPolicyFor(riskProfile);
  if (riskProfile === 'fast') return Object.freeze({ required: false, mode: 'none', maxAttempts: 0 });
  if (riskProfile === 'standard' && !standardAuditRequiredFor({ repository, standardAuditRequired })) {
    return Object.freeze({ required: false, mode: 'none', maxAttempts: 0 });
  }
  return Object.freeze({ required: policy.auditRequired, mode: policy.auditMode, maxAttempts: policy.maxAuditAttempts });
}
