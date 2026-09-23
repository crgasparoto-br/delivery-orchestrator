// Issue #213 contractual metrics that the previous SHA did not deliver:
// - aggregation by workflow run / implementation attempt / remediation attempt;
// - `providerCalls` as a real provider-call counter, distinct from `entriesCount`;
// - implementation/audit/remediation attempts derived from distinct identities.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateLedgerEntries,
  deriveLedgerEntries,
  groupLedgerEntries,
  GROUP_BY_DIMENSIONS
} from '../src/v2/ai-usage-ledger.mjs';
import { createDeliveryMetrics } from '../src/v2/metrics.mjs';
import { toCsv, toHtml, toJobSummary } from '../scripts/ai-usage-export.mjs';
import { printHumanSummary } from '../scripts/ai-usage-report.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function baseInput(overrides = {}) {
  return {
    repository: 'acme/example',
    issueNumber: 213,
    pullRequestNumber: 214,
    materialHeadSha: SHA_A,
    risk: 'fast',
    provider: 'codex',
    classifier: { version: 'v2', fingerprint: 'fp' },
    providerCalls: 1,
    attempts: { implementation: 1, audit: 0 },
    aiUsage: {},
    observedAtIso: '2026-09-01T12:00:00.000Z',
    durationsMs: { ciQueue: 0, ciExecution: 1, audit: 0, endToEnd: 2 },
    terminalReason: 'ready-for-human-merge',
    change: { files: 1, additions: 1, deletions: 0 },
    escalated: false,
    evidenceRefs: ['github:run/1'],
    ...overrides
  };
}

function run(overrides = {}) {
  return {
    phase: 'implementation',
    provider: 'codex',
    usage: {},
    reportedCost: null,
    estimatedCost: null,
    endedAtIso: '2026-09-01T12:00:00.000Z',
    ...overrides
  };
}

// --- F-214-01: the three contractual aggregation dimensions ---------------------------------

test('F-214-01: workflow-run, implementation-attempt and remediation-attempt are group-by dimensions', () => {
  assert.equal(GROUP_BY_DIMENSIONS['workflow-run'], 'workflowRunId');
  assert.equal(GROUP_BY_DIMENSIONS['implementation-attempt'], 'implementationAttempt');
  assert.equal(GROUP_BY_DIMENSIONS['remediation-attempt'], 'remediationAttempt');
});

test('F-214-01: group-by workflow-run separates runs of different workflow runs', () => {
  const record = createDeliveryMetrics(baseInput({
    providerCalls: 2,
    providerRunLedger: [
      run({ runId: 9001, workflowRunId: 100, implementationAttempt: 1, remediationAttempt: 0 }),
      run({ runId: 9002, workflowRunId: 200, implementationAttempt: 2, remediationAttempt: 1, phase: 'remediation' })
    ]
  }));
  const entries = deriveLedgerEntries([record]);

  const byWorkflowRun = groupLedgerEntries(entries, ['workflow-run']);
  assert.deepEqual(Object.keys(byWorkflowRun), ['100', '200']);
  assert.equal(byWorkflowRun['100'].providerRuns, 1);
  assert.equal(byWorkflowRun['200'].providerRuns, 1);

  const byImplementationAttempt = groupLedgerEntries(entries, ['implementation-attempt']);
  assert.deepEqual(Object.keys(byImplementationAttempt), ['1', '2']);

  const byRemediationAttempt = groupLedgerEntries(entries, ['remediation-attempt']);
  assert.deepEqual(Object.keys(byRemediationAttempt), ['0', '1']);
});

test('F-214-01: an entry without attempt identity groups as unknown, never as 0', () => {
  const record = createDeliveryMetrics(baseInput({
    aiUsage: { turns: 1 },
    aiUsageByStage: { implementation: { turns: 1 } }
  }));
  const entries = deriveLedgerEntries([record]);
  assert.deepEqual(Object.keys(groupLedgerEntries(entries, ['implementation-attempt'])), ['unknown']);
  assert.deepEqual(Object.keys(groupLedgerEntries(entries, ['workflow-run'])), ['unknown']);
});

// --- F-214-02: providerCalls is not entriesCount ---------------------------------------------

test('F-214-02: a proven zero-call delivery is 1 ledger entry and 0 provider calls', () => {
  const record = createDeliveryMetrics(baseInput({
    providerCalls: 0,
    providerRunAccounting: 'complete',
    providerRunLedger: []
  }));
  const entries = deriveLedgerEntries([record]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'zero-calls');

  const totals = aggregateLedgerEntries(entries);
  assert.equal(totals.entriesCount, 1);
  assert.equal(totals.providerCalls, 0);
  assert.equal(totals.providerCallsAccounting, 'complete');
  assert.equal(totals.zeroProviderCallEntries, 1);
  // The old surface printed calls=entriesCount, which would have said 1.
  assert.notEqual(totals.providerCalls, totals.entriesCount);
});

test('F-214-02: a real provider run counts exactly one provider call', () => {
  const record = createDeliveryMetrics(baseInput({
    providerRunLedger: [run({ runId: 9101, implementationAttempt: 1, remediationAttempt: 0 })]
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([record]));
  assert.equal(totals.providerCalls, 1);
  assert.equal(totals.providerRuns, 1);
  assert.equal(totals.entriesCount, 1);
  assert.equal(totals.providerCallsAccounting, 'complete');
});

test('F-214-02: two legacy rows never become two provider calls', () => {
  const record = createDeliveryMetrics(baseInput({
    aiUsage: { turns: 4 },
    aiUsageByStage: { implementation: { turns: 3 }, audit: { turns: 1 } }
  }));
  const entries = deriveLedgerEntries([record]);
  assert.equal(entries.length, 2);
  assert.equal(entries.every((entry) => entry.kind === 'legacy-aggregate'), true);

  const totals = aggregateLedgerEntries(entries);
  assert.equal(totals.entriesCount, 2);
  assert.equal(totals.legacyEntries, 2);
  // Unknown, not 2 and not a fabricated 0.
  assert.equal(totals.providerCalls, null);
  assert.equal(totals.providerCallsAccounting, 'unknown');
  assert.equal(totals.unknownProviderCallEntries, 2);
});

test('F-214-02: known runs mixed with legacy rows stay partial without inflating calls', () => {
  const modern = createDeliveryMetrics(baseInput({
    providerRunLedger: [run({ runId: 9201, implementationAttempt: 1, remediationAttempt: 0 })]
  }));
  const legacy = createDeliveryMetrics(baseInput({
    materialHeadSha: SHA_B,
    aiUsage: { turns: 2 },
    aiUsageByStage: { implementation: { turns: 2 } }
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([modern, legacy]));
  assert.equal(totals.entriesCount, 2);
  assert.equal(totals.providerCalls, 1);
  assert.equal(totals.providerCallsAccounting, 'partial');
  assert.equal(totals.unknownProviderCallEntries, 1);
});

// --- F-214-03: contractual attempts ----------------------------------------------------------

test('F-214-03: two provider runs of one implementation attempt are 2 runs and 1 attempt', () => {
  const record = createDeliveryMetrics(baseInput({
    providerCalls: 2,
    attempts: { implementation: 1, audit: 0 },
    providerRunLedger: [
      run({ runId: 9301, implementationAttempt: 1, remediationAttempt: 0 }),
      run({ runId: 9302, implementationAttempt: 1, remediationAttempt: 0, phase: 'audit' })
    ]
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([record]));
  assert.equal(totals.providerRuns, 2);
  assert.equal(totals.providerCalls, 2);
  assert.equal(totals.implementationAttempts, 1);
  assert.equal(totals.attempts.implementation.accounting, 'complete');
});

test('F-214-03: two distinct remediations count as two remediation attempts', () => {
  const record = createDeliveryMetrics(baseInput({
    providerCalls: 3,
    attempts: { implementation: 1, audit: 2 },
    providerRunLedger: [
      run({ runId: 9401, implementationAttempt: 1, remediationAttempt: 0 }),
      run({ runId: 9402, implementationAttempt: 1, remediationAttempt: 1, phase: 'remediation' }),
      run({ runId: 9403, implementationAttempt: 1, remediationAttempt: 2, phase: 'remediation' })
    ]
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([record]));
  assert.equal(totals.remediationAttempts, 2);
  assert.equal(totals.attempts.remediation.accounting, 'complete');
  assert.equal(totals.remediationRuns, 2);
  // Summing the persisted attempt numbers (0+1+2) would have produced 3.
  assert.notEqual(totals.remediationAttempts, 3);
});

test('F-214-03: the same attempt number in two deliveries is two distinct attempts', () => {
  const first = createDeliveryMetrics(baseInput({
    providerRunLedger: [run({ runId: 9501, implementationAttempt: 1, remediationAttempt: 1, phase: 'remediation' })]
  }));
  const second = createDeliveryMetrics(baseInput({
    materialHeadSha: SHA_B,
    providerRunLedger: [run({ runId: 9502, implementationAttempt: 1, remediationAttempt: 1, phase: 'remediation' })]
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([first, second]));
  assert.equal(totals.implementationAttempts, 2);
  assert.equal(totals.remediationAttempts, 2);
});

test('F-214-03: audit attempts come from the canonical record field, once per delivery', () => {
  const record = createDeliveryMetrics(baseInput({
    providerCalls: 2,
    attempts: { implementation: 1, audit: 3 },
    providerRunLedger: [
      run({ runId: 9601, implementationAttempt: 1, remediationAttempt: 0, phase: 'audit' }),
      run({ runId: 9602, implementationAttempt: 1, remediationAttempt: 0, phase: 'audit' })
    ]
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([record]));
  // Two audit provider runs, but the canonical audit attempt count is read once, not doubled.
  assert.equal(totals.auditRuns, 2);
  assert.equal(totals.auditAttempts, 3);
  assert.equal(totals.attempts.audit.accounting, 'complete');
});

test('F-214-03: legacy history keeps attempts unknown instead of fabricating zero', () => {
  const record = createDeliveryMetrics(baseInput({
    aiUsage: { turns: 1 },
    aiUsageByStage: { implementation: { turns: 1 } }
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([record]));
  assert.equal(totals.implementationAttempts, null);
  assert.equal(totals.attempts.implementation.accounting, 'unknown');
  assert.equal(totals.attempts.implementation.unknownEntries, 1);
  assert.equal(totals.remediationAttempts, null);
  assert.equal(totals.attempts.remediation.accounting, 'unknown');
});

test('F-214-03: a run with known attempts next to a legacy row stays partial, not complete', () => {
  const modern = createDeliveryMetrics(baseInput({
    providerRunLedger: [run({ runId: 9701, implementationAttempt: 1, remediationAttempt: 0 })]
  }));
  const legacy = createDeliveryMetrics(baseInput({
    materialHeadSha: SHA_B,
    aiUsage: { turns: 1 },
    aiUsageByStage: { implementation: { turns: 1 } }
  }));
  const totals = aggregateLedgerEntries(deriveLedgerEntries([modern, legacy]));
  assert.equal(totals.implementationAttempts, 1);
  assert.equal(totals.attempts.implementation.accounting, 'partial');
  assert.equal(totals.attempts.implementation.unknownEntries, 1);
});

// --- Export consistency ----------------------------------------------------------------------

function buildPayload(records, groupBy = ['repository', 'phase']) {
  const entries = deriveLedgerEntries(records);
  return {
    schemaVersion: 1,
    generatedAtIso: '2026-09-23T00:00:00.000Z',
    storePath: '/tmp/store.json',
    storePresent: true,
    period: { from: null, to: null, timezone: 'UTC' },
    filters: {},
    totalDeliveries: records.length,
    unknownTerminalTimestampEntries: 0,
    totals: aggregateLedgerEntries(entries),
    groups: groupLedgerEntries(entries, groupBy),
    byDay: groupLedgerEntries(entries, ['day']),
    byRepository: groupLedgerEntries(entries, ['repository']),
    byPhase: groupLedgerEntries(entries, ['phase']),
    byProviderModel: groupLedgerEntries(entries, ['provider', 'model']),
    byIssue: groupLedgerEntries(entries, ['repository', 'issue']),
    byPullRequest: groupLedgerEntries(entries, ['repository', 'pr']),
    entries,
    budget: { warnings: [] }
  };
}

test('export consistency: CLI, CSV, HTML and Job Summary agree on calls and attempts', () => {
  const record = createDeliveryMetrics(baseInput({
    providerCalls: 3,
    attempts: { implementation: 2, audit: 1 },
    providerRunLedger: [
      run({ runId: 9801, implementationAttempt: 1, remediationAttempt: 0 }),
      run({ runId: 9802, implementationAttempt: 2, remediationAttempt: 0 }),
      run({ runId: 9803, implementationAttempt: 2, remediationAttempt: 1, phase: 'remediation' })
    ]
  }));
  const payload = buildPayload([record], ['delivery']);
  const { totals } = payload;
  assert.equal(totals.providerCalls, 3);
  assert.equal(totals.entriesCount, 3);
  assert.equal(totals.implementationAttempts, 2);
  assert.equal(totals.auditAttempts, 1);
  assert.equal(totals.remediationAttempts, 1);

  const lines = [];
  printHumanSummary(payload, (line) => lines.push(line));
  const cli = lines.join('\n');
  assert.match(cli, /provider calls:\s+3 \(complete\)/);
  assert.match(cli, /ledger entries:\s+3/);
  assert.match(cli, /implementation attempts: 2 \(complete\)/);
  assert.match(cli, /audit attempts:\s+1 \(complete\)/);
  assert.match(cli, /remediation attempts:\s+1 \(complete\)/);
  // The breakdown must not present ledger entries as provider calls.
  assert.match(cli, /calls=3 entries=3 implAttempts=2 auditAttempts=1 remedAttempts=1/);

  const csv = toCsv(payload);
  const [header, dataRow] = csv.trim().split('\n');
  const columns = header.split(',');
  const values = dataRow.split(',');
  const cell = (name) => values[columns.indexOf(name)];
  for (const column of ['providerCalls', 'implementationAttempts', 'auditAttempts', 'remediationAttempts']) {
    assert.ok(columns.includes(column), `CSV must carry a ${column} column`);
  }
  assert.equal(cell('providerCalls'), '3');
  assert.equal(cell('entries'), '3');
  assert.equal(cell('implementationAttempts'), '2');
  assert.equal(cell('auditAttempts'), '1');
  assert.equal(cell('remediationAttempts'), '1');

  const html = toHtml(payload);
  assert.match(html, /3 provider calls \(complete\)/);
  assert.match(html, /<dt>Implementation attempts<\/dt><dd>2 \(complete\)<\/dd>/);
  assert.match(html, /<dt>Audit attempts<\/dt><dd>1 \(complete\)<\/dd>/);
  assert.match(html, /<dt>Remediation attempts<\/dt><dd>1 \(complete\)<\/dd>/);

  const summary = toJobSummary(payload);
  assert.match(summary, /\| Provider calls \| 3 \(complete\) \|/);
  assert.match(summary, /\| Ledger entries \| 3 \|/);
  assert.match(summary, /\| Implementation attempts \| 2 \(complete\) \|/);
  assert.match(summary, /\| Audit attempts \| 1 \(complete\) \|/);
  assert.match(summary, /\| Remediation attempts \| 1 \(complete\) \|/);
});

test('export consistency: unknown calls and attempts are rendered as unknown, never as 0', () => {
  const record = createDeliveryMetrics(baseInput({
    aiUsage: { turns: 1 },
    aiUsageByStage: { implementation: { turns: 1 } }
  }));
  const payload = buildPayload([record], ['delivery']);

  const lines = [];
  printHumanSummary(payload, (line) => lines.push(line));
  const cli = lines.join('\n');
  assert.match(cli, /provider calls:\s+unknown \(unknown\)/);
  assert.match(cli, /implementation attempts: unknown \(unknown\)/);
  assert.match(cli, /calls=unknown entries=1 implAttempts=unknown/);

  const csv = toCsv(payload);
  const columns = csv.trim().split('\n')[0].split(',');
  const values = csv.trim().split('\n')[1].split(',');
  assert.equal(values[columns.indexOf('providerCalls')], 'unknown');
  assert.equal(values[columns.indexOf('implementationAttempts')], 'unknown');
  assert.equal(values[columns.indexOf('remediationAttempts')], 'unknown');
  // Audit attempts stay canonical even for legacy records.
  assert.equal(values[columns.indexOf('auditAttempts')], '0');

  assert.match(toHtml(payload), /unknown provider calls \(unknown\)/);
  assert.match(toJobSummary(payload), /\| Provider calls \| unknown \(unknown\) \|/);
});
