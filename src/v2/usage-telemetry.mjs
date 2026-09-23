const NUMBER_KEYS = Object.freeze({
  turns: new Set(['turns', 'turn_count', 'turncount']),
  credits: new Set(['credits', 'ai_credits', 'aic', 'total_aic']),
  inputTokens: new Set(['input_tokens', 'inputtokens', 'prompt_tokens', 'prompttokens']),
  outputTokens: new Set(['output_tokens', 'outputtokens', 'completion_tokens', 'completiontokens']),
  totalTokens: new Set(['total_tokens', 'totaltokens'])
});

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function keyName(value) {
  return String(value).trim().toLowerCase().replaceAll('-', '_');
}

function collectNumbers(value, out, seen = new Set()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, seen);
    return;
  }
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = keyName(rawKey);
    for (const [metric, aliases] of Object.entries(NUMBER_KEYS)) {
      if (aliases.has(key)) {
        const number = finiteNonNegative(rawValue);
        if (number != null) out[metric].push(number);
      }
    }
    collectNumbers(rawValue, out, seen);
  }
}

function nullableSum(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function nullableMax(values) {
  return values.length === 0 ? null : Math.max(...values);
}

export function normalizeGhAwUsage(payload) {
  const values = { turns: [], credits: [], inputTokens: [], outputTokens: [], totalTokens: [] };
  collectNumbers(payload, values);
  const inputTokens = nullableMax(values.inputTokens);
  const outputTokens = nullableMax(values.outputTokens);
  const explicitTotal = nullableMax(values.totalTokens);
  return Object.freeze({
    turns: nullableMax(values.turns),
    credits: nullableMax(values.credits),
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null)
  });
}

export function parseGhAwUsageJsonl(text) {
  const records = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid gh-aw usage JSONL at line ${index + 1}: ${error.message}`); }
  });
  return normalizeGhAwUsage(records);
}

export function mergeGhAwUsage(observations) {
  if (!Array.isArray(observations)) throw new Error('observations must be an array');
  const normalized = observations.map(normalizeGhAwUsage);
  const values = (key) => normalized.map((item) => item[key]).filter((item) => item != null);
  return Object.freeze({
    turns: nullableSum(values('turns')),
    credits: nullableSum(values('credits')),
    inputTokens: nullableSum(values('inputTokens')),
    outputTokens: nullableSum(values('outputTokens')),
    totalTokens: nullableSum(values('totalTokens'))
  });
}

/**
 * Evidence extracted from a provider usage payload beyond raw token counters.
 *
 * Everything here is strictly evidence-driven: a field the payload does not carry stays `null`
 * (unknown) rather than being invented. In particular a missing cost is never coerced to zero,
 * and a missing terminal timestamp is never replaced by "now" or by the delivery-level timestamp.
 */
const STRING_KEYS = Object.freeze({
  model: new Set(['model', 'model_id', 'model_name', 'modelid', 'modelname']),
  provider: new Set(['provider', 'engine', 'engine_id', 'engine_name', 'engineid']),
  currency: new Set(['currency', 'cost_currency', 'currency_code'])
});

const COST_KEYS = new Set(['cost', 'total_cost', 'cost_total', 'estimated_cost']);
const USD_COST_KEYS = new Set(['cost_usd', 'total_cost_usd', 'usd_cost', 'total_usd']);

const TIMESTAMP_KEYS = Object.freeze({
  startedAtIso: new Set(['started_at', 'start_time', 'startedat', 'starttime', 'run_started_at']),
  endedAtIso: new Set(['completed_at', 'ended_at', 'end_time', 'finished_at', 'endedat', 'endtime', 'completedat'])
});

const CACHE_KEYS = Object.freeze({
  cacheReadInputTokens: new Set(['cache_read_input_tokens', 'cached_tokens', 'cache_read_tokens', 'cachereadinputtokens']),
  cacheCreationInputTokens: new Set(['cache_creation_input_tokens', 'cache_write_tokens', 'cachecreationinputtokens'])
});

function firstNonEmptyString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function validIso(value) {
  const text = firstNonEmptyString(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function collectEvidence(value, out, seen = new Set()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectEvidence(item, out, seen);
    return;
  }
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = keyName(rawKey);
    for (const [field, aliases] of Object.entries(STRING_KEYS)) {
      if (aliases.has(key)) {
        const text = firstNonEmptyString(rawValue);
        if (text) out[field].push(text);
      }
    }
    for (const [field, aliases] of Object.entries(TIMESTAMP_KEYS)) {
      if (aliases.has(key)) {
        const iso = validIso(rawValue);
        if (iso) out[field].push(iso);
      }
    }
    for (const [field, aliases] of Object.entries(CACHE_KEYS)) {
      if (aliases.has(key)) {
        const number = finiteNonNegative(rawValue);
        if (number != null) out[field].push(number);
      }
    }
    if (COST_KEYS.has(key)) {
      const number = finiteNonNegative(rawValue);
      if (number != null) out.cost.push(number);
    }
    if (USD_COST_KEYS.has(key)) {
      const number = finiteNonNegative(rawValue);
      if (number != null) out.usdCost.push(number);
    }
    collectEvidence(rawValue, out, seen);
  }
}

export function extractGhAwRunEvidence(payload) {
  const found = {
    model: [], provider: [], currency: [],
    startedAtIso: [], endedAtIso: [],
    cacheReadInputTokens: [], cacheCreationInputTokens: [],
    cost: [], usdCost: []
  };
  collectEvidence(payload, found);

  // A cost is only trusted when its currency is unambiguous: either explicitly stated, or
  // carried by a `*_usd`-suffixed key. A bare `cost` with no currency stays unknown.
  const explicitCurrency = found.currency[0] ? found.currency[0].toUpperCase() : null;
  let reportedCost = null;
  if (found.usdCost.length > 0) {
    reportedCost = Object.freeze({ amount: Math.max(...found.usdCost), currency: 'USD' });
  } else if (found.cost.length > 0 && explicitCurrency) {
    reportedCost = Object.freeze({ amount: Math.max(...found.cost), currency: explicitCurrency });
  }

  return Object.freeze({
    model: found.model[0] ?? null,
    provider: found.provider[0] ? found.provider[0].toLowerCase() : null,
    startedAtIso: found.startedAtIso.length > 0
      ? found.startedAtIso.sort()[0]
      : null,
    endedAtIso: found.endedAtIso.length > 0
      ? found.endedAtIso.sort().at(-1)
      : null,
    cacheReadInputTokens: nullableMax(found.cacheReadInputTokens),
    cacheCreationInputTokens: nullableMax(found.cacheCreationInputTokens),
    reportedCost
  });
}
