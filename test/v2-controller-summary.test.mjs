import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  DELIVERY_SUMMARY_HEADINGS,
  DELIVERY_SUMMARY_OUTCOMES,
  appendDeliveryControllerSummary,
  buildDeliveryControllerSummary,
  classifyDeliveryControllerOutcome,
  deliveryBlockers,
  formatDeliveryBlocker,
  operationalGuidanceForDelivery,
  parseControllerTechnicalErrors,
  recordControllerTechnicalError
} from '../src/v2/controller-summary.mjs';
import { evaluateReleaseGate } from '../src/v2/release-gate.mjs';
import { createPersistentDeliveryState } from '../src/v2/persistent-state.mjs';
import { collectDeliveryControllerSummaryInput } from '../scripts/publish-delivery-v2-controller-summary.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPOSITORY = 'crgasparoto-br/training-system';
const IDENTITY = Object.freeze({ repository: REPOSITORY, issueNumber: '217', baseBranch: 'main', runUrl: 'https://github.com/crgasparoto-br/delivery-orchestrator/actions/runs/99' });
const GREEN = Object.freeze({ jobStatus: 'success', guardOutcome: 'success', controllerOutcome: 'success', errors: [] });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// Canonical shape produced by evaluateOperationalRelease for a ready state.
function operationalRelease(sha) {
  const release = evaluateReleaseGate({
    schemaVersion: 1,
    repository: REPOSITORY,
    pullRequestNumber: 42,
    materialHeadSha: sha,
    currentRemoteHeadSha: sha,
    evidenceCollection: { materialHeadSha: sha, remoteHeadSha: sha, evidenceRef: `github:${REPOSITORY}#42@${sha}` },
    classifier: { subjectSha: sha, profile: 'fast', version: 'v2', fingerprint: 'fp', expectedFingerprint: 'fp', evidenceRef: 'artifact:classifier' },
    mergePreview: { required: false },
    checks: [{ name: 'Validate repository', required: true, subjectSha: sha, status: 'completed', conclusion: 'success', workflowRunId: 1001, evidenceRef: 'github:check/1001' }],
    unresolvedFindings: [],
    blockers: []
  });
  assert.equal(release.readiness, true);
  return { readiness: release.readiness, state: release.state, reasons: release.reasons, nextAction: 'human-merge-policy', release };
}

function completedResult(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'ready-for-human-merge',
    repository: REPOSITORY,
    issueNumber: 217,
    pullRequestNumber: 42,
    materialHeadSha: SHA_A,
    risk: 'fast',
    releaseReady: true,
    release: operationalRelease(SHA_A),
    nextAction: 'human-merge-policy',
    ...overrides
  };
}

// Equivalent of the payload that originated issue #217 (legacy adoption refreeze, workflow green).
function blockedAdoptionResult(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'legacy-adopted',
    phase: 'blocked',
    repository: REPOSITORY,
    issueNumber: 217,
    pullRequestNumber: 42,
    headRef: 'feat/217',
    materialHeadSha: SHA_A,
    nextAction: 'collect-adoption-evidence',
    providerCalls: 0,
    releaseReady: false,
    adoption: { phase: 'blocked', blockers: ['audit-continuation-required'], nextAction: 'collect-adoption-evidence' },
    ...overrides
  };
}

test('CONCLUIDA only with releaseReady, a valid release gate and exact-head evidence', () => {
  const markdown = buildDeliveryControllerSummary({ result: completedResult(), identity: IDENTITY, technical: GREEN });
  assert.match(markdown, /^# DELIVERY V2: CONCLUIDA$/m);
  assert.match(markdown, /\| Release ready \| `true` \|/);
  assert.match(markdown, /\| Release gate \| `ready-for-human-merge \(Delivery V2 Release: success\)` \|/);
  assert.match(markdown, new RegExp(`\\| HEAD material \\(exact-head\\) \\| \`${SHA_A}\` \\|`));
  assert.match(markdown, new RegExp(`\\| HEAD certificado \\| \`${SHA_A}\` \\|`));
  assert.match(markdown, /Nenhuma acao adicional do controller e necessaria antes do merge manual/);
  assert.match(markdown, /nao faz merge automaticamente/);
  assert.doesNotMatch(markdown, /ACAO DO USUARIO NECESSARIA/);
  assert.doesNotMatch(markdown, /DELIVERY V2: BLOQUEADA|ERRO TECNICO/);
});

test('BLOQUEADA with nextAction reproduces the issue #217 case with operational guidance', () => {
  const markdown = buildDeliveryControllerSummary({ result: blockedAdoptionResult(), identity: IDENTITY, technical: GREEN });
  assert.match(markdown, /^# DELIVERY V2: BLOQUEADA$/m);
  assert.match(markdown, /^## ACAO DO USUARIO NECESSARIA$/m);
  assert.match(markdown, /\| Phase \| `blocked` \|/);
  assert.match(markdown, /\| Release ready \| `false` \|/);
  assert.match(markdown, /- `audit-continuation-required`/);
  assert.match(markdown, /\| nextAction \(interno\) \| `collect-adoption-evidence` \|/);
  assert.match(markdown, /evidencia confiavel exigida/);
  assert.match(markdown, /Retome o ciclo com uma nova execucao do orquestrador/);
  assert.match(markdown, /^@Orquestrador Issue 217$/m);
  assert.match(markdown, /gh workflow run delivery-v2-dispatch\.yml -f target_repository=crgasparoto-br\/training-system -f target_issue=217 -f base_branch=main/);
  assert.match(markdown, /\| Repository \| `crgasparoto-br\/training-system` \|/);
  assert.match(markdown, /\| Issue \| \[#217\]/);
  assert.match(markdown, /\| PR \| \[#42\]\(https:\/\/github\.com\/crgasparoto-br\/training-system\/pull\/42\) \|/);
  assert.doesNotMatch(markdown, /DELIVERY V2: CONCLUIDA/);
  assert.doesNotMatch(markdown, /\[object Object\]/);
});

test('BLOQUEADA without nextAction never claims completion and offers a safe fallback', () => {
  for (const nextAction of [null, undefined, '', '   ']) {
    const result = blockedAdoptionResult({ nextAction, adoption: { phase: 'blocked', blockers: ['audit-continuation-required'] } });
    const markdown = buildDeliveryControllerSummary({ result, identity: IDENTITY, technical: GREEN });
    assert.match(markdown, /^# DELIVERY V2: BLOQUEADA$/m);
    assert.match(markdown, /ACAO DO USUARIO NECESSARIA/);
    assert.doesNotMatch(markdown, /CONCLUIDA/);
    assert.match(markdown, /nao informou nextAction/);
    assert.match(markdown, /NAO esta pronta para merge/);
    assert.match(markdown, /^@Orquestrador Issue 217$/m);
    assert.match(markdown, /\| nextAction \(interno\) \| _\(ausente\)_ \|/);
  }
  // Unknown nextAction values are shown verbatim and still fall back safely.
  const unknown = buildDeliveryControllerSummary({ result: blockedAdoptionResult({ nextAction: 'brand-new-action' }), identity: IDENTITY, technical: GREEN });
  assert.match(unknown, /DELIVERY V2: BLOQUEADA/);
  assert.match(unknown, /`brand-new-action`, que nao possui traducao operacional conhecida/);
});

test('ERRO TECNICO is distinct from a functional block and never claims completion', () => {
  const failing = { jobStatus: 'failure', guardOutcome: 'success', controllerOutcome: 'failure', errors: [{ source: 'controller', message: 'initial implementation worker failed: https://example/run/1' }] };
  const markdown = buildDeliveryControllerSummary({ result: null, identity: IDENTITY, technical: failing });
  assert.match(markdown, /^# DELIVERY V2: ERRO TECNICO$/m);
  assert.match(markdown, /A execucao tecnica falhou\. A entrega \*\*nao\*\* foi concluida/);
  assert.match(markdown, /- controller: failure/);
  assert.match(markdown, /- controller: initial implementation worker failed: https:\/\/example\/run\/1/);
  assert.match(markdown, /^@Orquestrador Issue 217$/m);
  assert.doesNotMatch(markdown, /DELIVERY V2: BLOQUEADA|DELIVERY V2: CONCLUIDA/);

  // A failed job wins even over a result that looks release-ready.
  const afterReady = buildDeliveryControllerSummary({ result: completedResult(), identity: IDENTITY, technical: { ...GREEN, jobStatus: 'failure' } });
  assert.match(afterReady, /DELIVERY V2: ERRO TECNICO/);
  assert.doesNotMatch(afterReady, /DELIVERY V2: CONCLUIDA/);

  // A failure that still persisted a functional result keeps that state visible for diagnosis.
  const auditFailed = buildDeliveryControllerSummary({
    result: { status: 'audit-workflow-failed', repository: REPOSITORY, issueNumber: 217, pullRequestNumber: 42, materialHeadSha: SHA_A, terminalReason: 'independent-audit-workflow-failure' },
    identity: IDENTITY,
    technical: { ...GREEN, controllerOutcome: 'failure', jobStatus: 'failure' }
  });
  assert.match(auditFailed, /DELIVERY V2: ERRO TECNICO/);
  assert.match(auditFailed, /- `independent-audit-workflow-failure`/);

  // No result and no failure signal is still not success: nothing functional was verified.
  const missing = classifyDeliveryControllerOutcome({ result: null, technical: GREEN });
  assert.equal(missing.outcome, DELIVERY_SUMMARY_OUTCOMES.technicalError);
  assert.match(missing.technicalFailures[0], /resultado do controller ausente/);
  assert.equal(classifyDeliveryControllerOutcome({ result: completedResult(), technical: { ...GREEN, guardOutcome: 'cancelled' } }).outcome, DELIVERY_SUMMARY_OUTCOMES.technicalError);
});

test('exact-head negative control: releaseReady=true bound to another SHA is not CONCLUIDA', () => {
  // Gate/evidence certified SHA A, but the current material head is SHA B.
  const stale = completedResult({ materialHeadSha: SHA_B, release: operationalRelease(SHA_A) });
  const markdown = buildDeliveryControllerSummary({ result: stale, identity: IDENTITY, technical: GREEN });
  assert.doesNotMatch(markdown, /DELIVERY V2: CONCLUIDA/);
  assert.match(markdown, /DELIVERY V2: BLOQUEADA/);
  assert.match(markdown, /ACAO DO USUARIO NECESSARIA/);
  assert.match(markdown, new RegExp(`release-gate-exact-head-mismatch: gate certificou ${SHA_A}; HEAD material atual ${SHA_B}`));
  assert.match(markdown, /certificar o HEAD material atual/);
  assert.doesNotMatch(markdown, /Nenhuma acao adicional do controller/);

  // releaseReady=true without canonical gate evidence, or with a non-ready gate, is not completion.
  for (const result of [
    completedResult({ release: null }),
    completedResult({ release: { ...operationalRelease(SHA_A), release: { ...operationalRelease(SHA_A).release, requiredStatus: { name: 'Delivery V2 Release', state: 'pending' } } } }),
    completedResult({ status: 'ci-pending' }),
    completedResult({ releaseReady: 'true' }),
    completedResult({ materialHeadSha: null })
  ]) {
    assert.equal(classifyDeliveryControllerOutcome({ result, technical: GREEN }).outcome, DELIVERY_SUMMARY_OUTCOMES.blocked);
  }
});

test('multiple blockers are all rendered in readable form', () => {
  const result = blockedAdoptionResult({
    adoption: { phase: 'blocked', blockers: ['classification-unknown', 'audit-continuation-required'] },
    blockers: [{ kind: 'external', code: 'ci-outage', evidenceRef: 'https://example/check/7' }, 'classification-unknown']
  });
  const markdown = buildDeliveryControllerSummary({ result, identity: IDENTITY, technical: GREEN });
  assert.match(markdown, /### Blockers \(3\)/);
  assert.match(markdown, /- `external: ci-outage \(evidencia: https:\/\/example\/check\/7\)`/);
  assert.match(markdown, /- `classification-unknown`/);
  assert.match(markdown, /- `audit-continuation-required`/);
  assert.doesNotMatch(markdown, /\[object Object\]/);
  assert.equal(formatDeliveryBlocker({ unexpected: 1 }), '{"unexpected":1}');
  assert.deepEqual(deliveryBlockers({ status: 'escalated', metrics: { terminalReason: 'implementation-budget-exhausted' } }), ['implementation-budget-exhausted']);
});

test('summary generation is observability only and never mutates the delivery state', () => {
  const persistent = createPersistentDeliveryState({
    repository: REPOSITORY, issueNumber: 217, pullRequestNumber: 42, baseRef: 'main', baseSha: SHA_B, headRef: 'feat/217',
    materialHeadSha: SHA_A, effectiveRisk: 'fast', provider: 'codex', status: 'ci-pending',
    classifier: { subjectSha: SHA_A, version: 'v2', fingerprint: 'fp' }
  });
  for (const fixture of [completedResult(), blockedAdoptionResult(), completedResult({ materialHeadSha: SHA_B })]) {
    const result = { ...fixture, persistent };
    const before = structuredClone(result);
    deepFreeze(result);
    const technical = deepFreeze(structuredClone(GREEN));
    buildDeliveryControllerSummary({ result, identity: IDENTITY, technical });
    classifyDeliveryControllerOutcome({ result, technical });
    operationalGuidanceForDelivery({ result, identity: IDENTITY, outcome: DELIVERY_SUMMARY_OUTCOMES.blocked });
    assert.deepEqual(result, before);
    assert.equal(result.releaseReady, before.releaseReady);
    assert.equal(result.phase, before.phase);
    assert.equal(result.nextAction, before.nextAction);
    assert.deepEqual(result.adoption?.blockers, before.adoption?.blockers);
    assert.equal(result.persistent.status, 'ci-pending');
  }
});

test('escalation guidance takes precedence over a stale in-flight nextAction', () => {
  const markdown = buildDeliveryControllerSummary({
    result: { status: 'escalated', repository: REPOSITORY, issueNumber: 217, pullRequestNumber: 42, materialHeadSha: SHA_A, releaseReady: false, release: null, nextAction: 'observe-remediation', metrics: { terminalReason: 'remediation-opened-higher-risk-surface' } },
    identity: IDENTITY,
    technical: GREEN
  });
  assert.match(markdown, /DELIVERY V2: BLOQUEADA/);
  assert.match(markdown, /escalou a entrega para decisao humana/);
  assert.match(markdown, /\| nextAction \(interno\) \| `observe-remediation` \|/);
  assert.match(markdown, /- `remediation-opened-higher-risk-surface`/);
});

test('reentry-only and needs-scope results are summarized as blocked with specific guidance', () => {
  const reentry = buildDeliveryControllerSummary({
    result: { schemaVersion: 1, status: 'escalated-initial-budget-exhausted', repository: REPOSITORY, issueNumber: 217, pullRequestNumber: null, materialHeadSha: null, providerCalls: 0, reentry: { nextAction: 'human-escalation' } },
    identity: IDENTITY,
    technical: { ...GREEN, controllerOutcome: 'skipped' }
  });
  assert.match(reentry, /DELIVERY V2: BLOQUEADA/);
  assert.match(reentry, /\| nextAction \(interno\) \| `human-escalation` \|/);
  assert.match(reentry, /Intervencao humana necessaria/);

  const scope = buildDeliveryControllerSummary({
    result: { schemaVersion: 1, status: 'needs-scope', targetRepository: REPOSITORY, issueNumber: 217, dispatchDecision: { dispatchAllowed: false, nextAction: 'collect-concrete-changed-paths', reason: 'auto-risk-without-concrete-paths' } },
    identity: IDENTITY,
    technical: GREEN
  });
  assert.match(scope, /DELIVERY V2: BLOQUEADA/);
  assert.match(scope, /- `auto-risk-without-concrete-paths`/);
  assert.match(scope, /-f changed_paths="<caminhos esperados>"/);
});

test('every nextAction literal emitted by the control plane has an operational translation', async () => {
  const sources = [];
  for (const dir of ['scripts', 'src/v2']) {
    for (const name of (await readdir(dir)).filter((item) => item.endsWith('.mjs'))) sources.push(await readFile(`${dir}/${name}`, 'utf8'));
  }
  const actions = new Set();
  for (const source of sources) for (const match of source.matchAll(/nextAction: '([a-z-]+)'/g)) actions.add(match[1]);
  assert.ok(actions.has('collect-adoption-evidence'));
  for (const nextAction of actions) {
    const guidance = operationalGuidanceForDelivery({ result: { status: 'legacy-adopted', nextAction }, identity: { issueNumber: 217 }, outcome: DELIVERY_SUMMARY_OUTCOMES.blocked });
    assert.notEqual(guidance.kind, 'fallback', `nextAction ${nextAction} has no operational translation`);
    assert.ok(guidance.commands.includes('@Orquestrador Issue 217'), `nextAction ${nextAction} has no resume command`);
  }
});

test('adapter writes to GITHUB_STEP_SUMMARY only when available', async () => {
  const writes = [];
  const append = async (...args) => { writes.push(args); };
  assert.equal(await appendDeliveryControllerSummary('# x\n', { summaryPath: '', append }), false);
  assert.equal(await appendDeliveryControllerSummary('# x\n', { summaryPath: '/tmp/summary.md', append }), true);
  assert.deepEqual(writes, [['/tmp/summary.md', '# x\n', 'utf8']]);
});

test('technical errors are recorded and read back for the summary step', async () => {
  const writes = [];
  const append = async (file, data) => { writes.push([file, data]); };
  assert.equal(await recordControllerTechnicalError(new Error('boom'), { errorPath: '', append }), false);
  assert.equal(await recordControllerTechnicalError(new Error('boom'), { source: 'controller', errorPath: '/tmp/e.jsonl', append }), true);
  assert.deepEqual(parseControllerTechnicalErrors(`${writes[0][1]}not-json\n`), [{ source: 'controller', message: 'boom' }, { source: 'execucao', message: 'not-json' }]);

  const files = {
    '/tmp/result.json': JSON.stringify(blockedAdoptionResult()),
    '/tmp/e.jsonl': writes[0][1]
  };
  const input = await collectDeliveryControllerSummaryInput({
    CONTROLLER_RESULT_PATH: '/tmp/result.json', CONTROLLER_ERROR_PATH: '/tmp/e.jsonl',
    TARGET_REPOSITORY: REPOSITORY, TARGET_ISSUE: '217', BASE_BRANCH: 'main',
    GITHUB_REPOSITORY: 'crgasparoto-br/delivery-orchestrator', GITHUB_RUN_ID: '99',
    DELIVERY_V2_JOB_STATUS: 'failure', DELIVERY_V2_GUARD_OUTCOME: 'success', DELIVERY_V2_CONTROLLER_OUTCOME: 'failure'
  }, { read: async (file) => files[file] ?? null });
  assert.equal(input.result.nextAction, 'collect-adoption-evidence');
  assert.deepEqual(input.technical.errors, [{ source: 'controller', message: 'boom' }]);
  assert.equal(input.identity.runUrl, 'https://github.com/crgasparoto-br/delivery-orchestrator/actions/runs/99');
  assert.match(buildDeliveryControllerSummary(input), /DELIVERY V2: ERRO TECNICO/);

  const unreadable = await collectDeliveryControllerSummaryInput({ CONTROLLER_RESULT_PATH: '/tmp/bad.json' }, { read: async (file) => (file === '/tmp/bad.json' ? '{' : null) });
  assert.equal(unreadable.result, null);
  assert.match(unreadable.technical.errors[0].message, /resultado do controller ilegivel/);
});

test('dispatch workflow publishes the functional summary from Node on every outcome', async () => {
  const body = await readFile('.github/workflows/delivery-v2-dispatch.yml', 'utf8');
  const step = body.slice(body.indexOf('- name: Publish controller summary')).split('\n      - name:')[0];
  assert.match(step, /if: always\(\)/);
  assert.match(step, /run: node scripts\/publish-delivery-v2-controller-summary\.mjs/);
  assert.match(step, /DELIVERY_V2_JOB_STATUS: \$\{\{ job\.status \}\}/);
  assert.match(step, /DELIVERY_V2_GUARD_OUTCOME: \$\{\{ steps\.reentry\.outcome \}\}/);
  assert.match(step, /DELIVERY_V2_CONTROLLER_OUTCOME: \$\{\{ steps\.controller\.outcome \}\}/);
  assert.doesNotMatch(body, /GITHUB_STEP_SUMMARY/);
  assert.match(body, /- name: Run bounded Delivery V2 controller\n        id: controller\n/);
  assert.match(body, /CONTROLLER_ERROR_PATH: \/tmp\/delivery-v2-controller-errors-\$\{\{ github\.run_id \}\}\.jsonl/);
  // The summary is the final operational step so job.status already includes failures from
  // evidence publication and every other preceding step.
  assert.ok(body.indexOf('- name: Publish controller summary') > body.indexOf('- name: Publish operational Delivery V2 metrics store'));
  assert.ok(body.indexOf('- name: Publish controller summary') > body.indexOf('- name: Upload delivery evidence'));

  const summaryPosition = body.indexOf('- name: Publish controller summary');
  const remainderAfterSummary = body.slice(
    summaryPosition + '- name: Publish controller summary'.length
  );
  assert.doesNotMatch(remainderAfterSummary, /\n      - name:/);
});

test('controller terminal payloads expose the canonical release evaluation and nextAction', async () => {
  for (const file of ['scripts/run-delivery-v2-controller.mjs', 'scripts/resume-delivery-v2-controller.mjs']) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /releaseReady: releaseEvaluation\?\.readiness === true,\n\s+release: releaseEvaluation,\n\s+nextAction: controller\.nextAction \?\? null,/);
    assert.match(source, /releaseEvaluation = release;/);
    assert.match(source, /recordControllerTechnicalError\(error, \{ source: 'controller' \}\)/);
  }
  const guard = await readFile('scripts/guard-delivery-v2-reentry.mjs', 'utf8');
  assert.match(guard, /recordControllerTechnicalError\(error, \{ source: 'reentry-guard' \}\)/);
  assert.equal(DELIVERY_SUMMARY_HEADINGS.userAction, 'ACAO DO USUARIO NECESSARIA');
});
