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

/** The scopes a remediation threshold is evaluated over: the whole window, then each grouping. */
function* remediationScopes(report) {
  yield ['total', null, report.totals];
  for (const [groupKey, group] of Object.entries(report.groups)) yield ['group', groupKey, group];
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
    const unknownCostEntries = Number.isInteger(report.totals.unknownCostEntries)
      ? report.totals.unknownCostEntries
      : 0;
    const knownSpent = bucket?.effectiveCost ?? null;

    // A known amount above the budget is conclusively exceeded even when other
    // provider-run costs remain unknown.
    if (knownSpent != null && knownSpent > config.monthly.amount) {
      warnings.push(Object.freeze({
        type: 'monthly-budget-exceeded',
        currency: config.monthly.currency,
        spent: knownSpent,
        limit: config.monthly.amount,
        accounting: bucket.accounting,
        unknownCostEntries
      }));
    } else if (unknownCostEntries > 0) {
      // Known spend below the limit does NOT prove that budget remains available
      // while one or more provider-run costs are unknown. Keep the budget warning
      // informative/non-blocking, but make the conclusion explicitly inconclusive.
      warnings.push(Object.freeze({
        type: 'monthly-budget-inconclusive',
        currency: config.monthly.currency,
        spent: knownSpent,
        limit: config.monthly.amount,
        accounting: report.totals.accounting ?? 'partial',
        unknownCostEntries
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

  // Remediation-volume warning. The threshold counts remediation ATTEMPTS, never provider runs:
  // one remediation attempt can execute several provider runs, so `remediationRuns` would
  // overstate it. The canonical metric is `attempts.remediation` (mirrored by
  // `remediationAttempts`), evaluated for the window overall and for each grouping.
  //
  // When attempts cannot be identified the threshold is NOT silently treated as met or unmet: an
  // unknown count never becomes zero. An explicit, still non-blocking informative warning records
  // that the threshold could not be evaluated conclusively. This is informative only: neither
  // warning ever blocks a delivery.
  if (config.warnings.remediationCount != null) {
    const limit = config.warnings.remediationCount;
    for (const [scope, groupKey, scopeTotals] of remediationScopes(report)) {
      const attempts = scopeTotals.attempts?.remediation ?? null;
      const observed = attempts ? attempts.total : null;
      const accounting = attempts ? attempts.accounting : 'unknown';
      if (observed != null && observed > limit) {
        warnings.push(Object.freeze({
          type: 'remediation-count-warning',
          scope,
          group: groupKey,
          remediationAttempts: observed,
          remediationRuns: scopeTotals.remediationRuns,
          accounting,
          limit
        }));
        continue;
      }
      // Unknown, or known-but-below-threshold while some entries carry no attempt identity: the
      // accounting is incomplete, so "not exceeded" is not a conclusion we are entitled to.
      if (observed == null || accounting !== 'complete') {
        warnings.push(Object.freeze({
          type: 'remediation-count-inconclusive',
          scope,
          group: groupKey,
          remediationAttempts: observed,
          remediationRuns: scopeTotals.remediationRuns,
          accounting,
          unknownEntries: attempts ? attempts.unknownEntries : null,
          limit
        }));
      }
    }
  }

  return Object.freeze({ configured: true, blocking: false, warnings: Object.freeze(warnings) });
}
