import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeDeliveryMetrics,
  summarizeDeliveryMetrics
} from '../src/v2/metrics.mjs';

const evidenceUrl = new URL('../docs/delivery-v2/evidence/dv2-011-live-metrics.json', import.meta.url);
const canonicalFingerprint = '35914f89844e0a6c35a436af1a1856e6a2b37ab7f5e0f3d3c1749e7a89d3ad24';

async function loadEvidence() {
  return JSON.parse(await readFile(evidenceUrl, 'utf8'));
}

test('DV2-011 live metrics evidence normalizes two real target repositories', async () => {
  const evidence = await loadEvidence();
  assert.equal(evidence.requirement, 'DV2-011');
  assert.equal(evidence.records.length, 2);

  const records = evidence.records.map(normalizeDeliveryMetrics);
  assert.deepEqual(
    records.map((record) => record.repository).sort(),
    ['crgasparoto-br/controle_calorias', 'crgasparoto-br/training-system']
  );

  for (const record of records) {
    assert.equal(record.risk, 'critical');
    assert.equal(record.provider, 'github-actions');
    assert.equal(record.providerCalls, 0);
    assert.equal(record.attempts.implementation, 1);
    assert.equal(record.attempts.audit, 0);
    assert.equal(record.aiUsage.totalTokens, null);
    assert.equal(record.providerCost.available, false);
    assert.equal(record.classifier.fingerprint, canonicalFingerprint);
    assert.ok(record.durationsMs.ciExecution > 0);
    assert.ok(record.durationsMs.endToEnd >= record.durationsMs.ciExecution);
    assert.ok(record.evidenceRefs.some((ref) => ref.startsWith('github-actions:')));
  }
});

test('DV2-011 live evidence preserves exact measured timing and diff facts', async () => {
  const evidence = await loadEvidence();
  const records = new Map(evidence.records.map((record) => [record.repository, normalizeDeliveryMetrics(record)]));

  const calories = records.get('crgasparoto-br/controle_calorias');
  assert.equal(calories.materialHeadSha, '0f0cf57ab5c541093d2b7928b3cdac998620ee1e');
  assert.equal(calories.durationsMs.ciQueue, 0);
  assert.equal(calories.durationsMs.ciExecution, 567000);
  assert.equal(calories.durationsMs.endToEnd, 3263000);
  assert.deepEqual(calories.change, { files: 7, additions: 272, deletions: 102, linesChanged: 374 });

  const training = records.get('crgasparoto-br/training-system');
  assert.equal(training.materialHeadSha, 'ae0fade7be03c6c66f00fbd605bd85d9259aa622');
  assert.equal(training.durationsMs.ciQueue, 0);
  assert.equal(training.durationsMs.ciExecution, 993000);
  assert.equal(training.durationsMs.endToEnd, 30167000);
  assert.deepEqual(training.change, { files: 11, additions: 839, deletions: 277, linesChanged: 1116 });
});

test('DV2-011 live evidence is usable for cross-repository comparison without invented cost data', async () => {
  const evidence = await loadEvidence();
  const summary = summarizeDeliveryMetrics(evidence.records);

  assert.equal(summary.totalDeliveries, 2);
  assert.equal(summary.overall.providerCalls, 0);
  assert.equal(summary.overall.auditAttempts, 0);
  assert.deepEqual(summary.overall.providerCostTotals, {});
  assert.ok(summary.byRepositoryRiskProvider['crgasparoto-br/controle_calorias|critical|github-actions']);
  assert.ok(summary.byRepositoryRiskProvider['crgasparoto-br/training-system|critical|github-actions']);
});
