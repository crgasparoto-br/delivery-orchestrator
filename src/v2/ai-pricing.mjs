/**
 * Versioned, in-repository AI pricing catalog used to derive `estimatedCost` for a provider run.
 *
 * Hard constraints (issue #213):
 * - pricing is read from a versioned file committed to this repository; there is never an
 *   external/network pricing lookup during a delivery;
 * - an unknown provider/model, or unknown token usage, yields `null` (unknown cost). Unknown is
 *   never coerced to zero;
 * - every estimate carries the `pricingSnapshot` (version + the exact rates applied) so a later
 *   pricing change never retroactively rewrites the cost of an already-recorded historical run;
 * - `reportedCost` always wins over `estimatedCost`; the two are never summed for the same run.
 */
import { readFile } from 'node:fs/promises';

export const AI_PRICING_SCHEMA_VERSION = 1;

export const DEFAULT_AI_PRICING_FILE = 'config/delivery-v2-ai-pricing.json';

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function requireRate(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

/** Normalizes a provider/model pair into a single safe catalog key. */
export function pricingKeyFor(provider, model) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const normalizedModel = String(model ?? '').trim().toLowerCase();
  if (!normalizedProvider || !normalizedModel) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalizedProvider)) return null;
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(normalizedModel)) return null;
  return `${normalizedProvider}/${normalizedModel}`;
}

export function normalizeAiPricingCatalog(raw) {
  const value = requireObject(raw, 'ai pricing catalog');
  if (value.schemaVersion !== AI_PRICING_SCHEMA_VERSION) {
    throw new Error(`ai pricing catalog schemaVersion must be ${AI_PRICING_SCHEMA_VERSION}`);
  }
  const pricingVersion = requireString(value.pricingVersion, 'ai pricing catalog.pricingVersion');
  const models = requireObject(value.models, 'ai pricing catalog.models');
  const normalized = {};
  for (const [rawKey, rawRates] of Object.entries(models)) {
    const key = requireString(rawKey, 'ai pricing catalog model key').toLowerCase();
    // Prototype-pollution safe: catalog lookups only ever read from this own-property map.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`unsafe ai pricing catalog model key: ${key}`);
    }
    const rates = requireObject(rawRates, `ai pricing catalog.models.${key}`);
    normalized[key] = Object.freeze({
      currency: requireString(rates.currency, `ai pricing catalog.models.${key}.currency`).toUpperCase(),
      inputPerMillionTokens: requireRate(rates.inputPerMillionTokens, `ai pricing catalog.models.${key}.inputPerMillionTokens`),
      outputPerMillionTokens: requireRate(rates.outputPerMillionTokens, `ai pricing catalog.models.${key}.outputPerMillionTokens`)
    });
  }
  return Object.freeze({
    schemaVersion: AI_PRICING_SCHEMA_VERSION,
    pricingVersion,
    models: Object.freeze(normalized)
  });
}

export async function loadAiPricingCatalog(filePath) {
  const resolved = requireString(filePath, 'ai pricing file path');
  return normalizeAiPricingCatalog(JSON.parse(await readFile(resolved, 'utf8')));
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Estimates the cost of a single provider run from committed pricing.
 *
 * Returns `null` (unknown) when the provider/model is not in the catalog or when neither input
 * nor output tokens are known. A run with a known token count but an unpriced model stays
 * unknown on purpose: fabricating a zero would understate real spend.
 */
export function estimateProviderRunCost({ provider, model, usage } = {}, catalog) {
  if (!catalog) return null;
  const key = pricingKeyFor(provider, model);
  if (!key) return null;
  const rates = Object.hasOwn(catalog.models, key) ? catalog.models[key] : null;
  if (!rates) return null;

  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  if (inputTokens == null && outputTokens == null) return null;

  const amount = round6(
    ((inputTokens ?? 0) / 1e6) * rates.inputPerMillionTokens +
    ((outputTokens ?? 0) / 1e6) * rates.outputPerMillionTokens
  );

  return Object.freeze({
    amount,
    currency: rates.currency,
    // Persisted with the run so a future catalog change never rewrites this historical estimate.
    pricingSnapshot: Object.freeze({
      version: catalog.pricingVersion,
      key,
      currency: rates.currency,
      inputPerMillionTokens: rates.inputPerMillionTokens,
      outputPerMillionTokens: rates.outputPerMillionTokens,
      // `partial` records that only one side of the token usage was known at estimation time.
      basis: inputTokens != null && outputTokens != null ? 'complete' : 'partial'
    })
  });
}
