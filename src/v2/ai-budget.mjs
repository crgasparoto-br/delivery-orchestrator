/**
 * Non-blocking AI usage/cost budget warnings.
 *
 * Explicitly out of scope (see issue #213): billing, automatic payment, API key rotation,
 * automatic currency conversion and hard limits that block a delivery. This module only ever
 * produces informative warnings derived from an already-computed `buildAiUsageReport` result;
 * it never mutates the report, never blocks, and never invents a cost/currency conversion.
 */

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

export function normalizeAiBudgetConfig(raw) {
  const value = requireObject(raw, 'ai budget config');
  const monthly = value.monthly == null ? null : requireObject(value.monthly, 'ai budget config.monthly');
  const warnings = value.warnings == null ? {} : requireObject(value.warnings, 'ai budget config.warnings');
  return Object.freeze({
    schemaVersion: 1,
    monthly: monthly == null ? null : Object.freeze({
      amount: Number(monthly.amount),
      currency: String(monthly.currency ?? '').trim().toUpperCase()
    }),
    warnings: Object.freeze({
      issueCost: warnings.issueCost == null ? null : Number(warnings.issueCost),
      remediationCount: warnings.remediationCount == null ? null : Number(warnings.remediationCount)
    })
  });
}

/**
 * Evaluates non-blocking budget warnings against an AI usage report.
 * `report.totals.costByCurrency`/`report.groups[*].costByCurrency` are the only cost inputs;
 * no external pricing lookup or currency conversion is performed.
 */
export function evaluateAiBudgetWarnings(report, budgetConfigRaw) {
  if (!budgetConfigRaw) return Object.freeze({ configured: false, blocking: false, warnings: Object.freeze([]) });
  const config = normalizeAiBudgetConfig(budgetConfigRaw);
  const warnings = [];

  if (config.monthly) {
    const bucket = report.totals.costByCurrency[config.monthly.currency];
    if (bucket && bucket.effectiveCost > config.monthly.amount) {
      warnings.push(Object.freeze({
        type: 'monthly-budget-exceeded',
        currency: config.monthly.currency,
        spent: bucket.effectiveCost,
        limit: config.monthly.amount,
        accounting: bucket.accounting
      }));
    }
  }

  if (config.warnings.issueCost != null) {
    for (const [groupKey, group] of Object.entries(report.groups)) {
      for (const [currency, cost] of Object.entries(group.costByCurrency)) {
        if (cost.effectiveCost > config.warnings.issueCost) {
          warnings.push(Object.freeze({
            type: 'group-cost-warning',
            group: groupKey,
            currency,
            amount: cost.effectiveCost,
            limit: config.warnings.issueCost,
            accounting: cost.accounting
          }));
        }
      }
    }
  }

  return Object.freeze({ configured: true, blocking: false, warnings: Object.freeze(warnings) });
}
