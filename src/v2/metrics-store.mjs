/**
 * The operational cross-delivery metrics source.
 *
 * There is exactly one such source: the canonical Delivery V2 metrics store file, written
 * through the canonical `metrics.mjs` contract (`upsertDeliveryMetrics`, keyed by `deliveryId`).
 * Both the initial controller and the resume controller persist their completed delivery metrics
 * here, and every consumer — `npm run metrics:v2`, `npm run ai:usage` and the manual
 * "Delivery V2 - AI Usage Report" workflow — reads this same file. No second, competing store
 * is introduced.
 *
 * Location: `docs/delivery-v2/evidence/delivery-v2-metrics.json`, overridable with the
 * `DELIVERY_V2_METRICS_FILE` environment variable. The dispatch workflow publishes the updated
 * store as run evidence and commits it back to the orchestrator repository, so the history is
 * durable across ephemeral runners.
 */
import path from 'node:path';
import { access } from 'node:fs/promises';
import { loadDeliveryMetricsStore, upsertDeliveryMetrics } from './metrics.mjs';

export const OPERATIONAL_METRICS_STORE_PATH = 'docs/delivery-v2/evidence/delivery-v2-metrics.json';

/** Resolves the single operational store path (env override wins, then the committed default). */
export function resolveOperationalMetricsStorePath({ cwd = process.cwd(), env = process.env } = {}) {
  const configured = String(env.DELIVERY_V2_METRICS_FILE ?? '').trim();
  return path.resolve(cwd, configured || OPERATIONAL_METRICS_STORE_PATH);
}

/**
 * Persists one completed delivery's metrics into the operational store.
 *
 * Idempotent by construction: `upsertDeliveryMetrics` is keyed by `deliveryId`, so a resume,
 * re-entry or recovery that recomputes the same delivery replaces its record instead of
 * appending a duplicate. Never throws into the delivery path: metrics persistence is
 * observability and must not fail a delivery that otherwise succeeded, so a write failure is
 * reported back to the caller instead.
 */
export async function persistOperationalDeliveryMetrics(metrics, { storePath = null, cwd = process.cwd(), env = process.env } = {}) {
  if (metrics == null) return Object.freeze({ persisted: false, reason: 'no-metrics', storePath: null });
  const resolved = storePath ? path.resolve(cwd, storePath) : resolveOperationalMetricsStorePath({ cwd, env });
  try {
    const record = await upsertDeliveryMetrics(resolved, metrics);
    return Object.freeze({ persisted: true, storePath: resolved, deliveryId: record.deliveryId });
  } catch (error) {
    return Object.freeze({ persisted: false, storePath: resolved, reason: error.message });
  }
}

/**
 * Loads the operational store for *reporting*.
 *
 * Unlike `loadDeliveryMetricsStore`, a missing store is an explicit, loud failure rather than an
 * empty report: a report that silently says "zero AI usage" because nobody ever produced the
 * store is indistinguishable from a report that says "zero AI usage" because nothing was spent.
 * `allowMissing` is opt-in for callers that genuinely want the empty-store case.
 */
export async function loadOperationalMetricsStore(storePath, { allowMissing = false } = {}) {
  const resolved = path.resolve(storePath);
  try {
    await access(resolved);
  } catch {
    if (allowMissing) {
      return Object.freeze({ schemaVersion: 1, records: Object.freeze([]), storePath: resolved, present: false });
    }
    throw new Error(
      `operational Delivery V2 metrics store not found at ${resolved}. ` +
      'It is produced by the Delivery V2 controller (run-delivery-v2-controller.mjs / ' +
      'resume-delivery-v2-controller.mjs) and committed under ' +
      `${OPERATIONAL_METRICS_STORE_PATH}. Pass --allow-missing-store to report an empty window ` +
      'explicitly, or --metrics-file to point at another store.'
    );
  }
  const store = await loadDeliveryMetricsStore(resolved);
  return Object.freeze({ ...store, storePath: resolved, present: true });
}
