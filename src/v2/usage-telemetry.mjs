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
