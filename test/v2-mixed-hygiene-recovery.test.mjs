import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import {
  applyOperationalEvent, createOperationalDelivery, evaluateOperationalRelease,
  nextOperationalAction, operationalStateFromPersistent, persistentStateFromOperational
} from '../src/v2/operational-controller.mjs';
import { reconcilePersistentState } from '../src/v2/persistent-state.mjs';
import {
  classifyUnknownHygieneEvidence, legacyTechnicalHygieneContext, main,
  rearmUnknownTechnicalHygiene, shouldRearmUnknownTechnicalHygiene
} from '../scripts/resume-delivery-v2-controller.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const CURRENT = 'd'.repeat(40);
const infrastructure = { code: 'SAFEOUTPUTS_UNAVAILABLE', detail: 'transport unavailable', material: true };
const semantic = { code: 'FRONTEND_RETRY_AND_PENDING_STATE_TEST_GAP', detail: 'retry and pending tests missing', material: true };
const telemetry = { code: 'PNPM_TOOL_MISSING', detail: 'optional tool unavailable', material: false };
const identity = { issueNumber: 208, pullRequestNumber: 468, baseRef: 'main', baseSha: BASE, headRef: 'fix/208', provider: 'codex' };
const classifier = { version: 'v1', fingerprint: 'fixture' };
const workflowChecks = [{ name: 'CI', subjectSha: HEAD, status: 'completed', conclusion: 'success', workflowRunId: 1, evidenceRef: 'ci:1' }];

function plan(risk = 'standard') {
  return createDeliveryPlan({ repository: 'owner/repo', issueNumber: 208, requestedRisk: risk,
    changedPaths: ['apps/web/src/components/Filter.tsx'], repositoryPolicy: { fastSafeRoots: ['apps/web/src/components'] },
    aiPolicy: { implementerProvider: 'codex', implementerModel: 'gpt-5.4', auditorProvider: 'claude', auditorModel: 'claude-opus-5' } });
}

function hygiene(result = 'UNKNOWN', missingEvidence = [infrastructure, semantic, telemetry], profile = 'standard') {
  return { schemaVersion: 1, baselineSha: BASE, materialSha: HEAD, result, missingEvidence,
    effectiveProfile: profile, promotionRequired: profile === 'fast' && result === 'UNKNOWN', evidenceRef: 'artifact:hygiene' };
}

function pending(risk = 'standard') {
  let state = createOperationalDelivery({ plan: plan(risk), materialHeadSha: HEAD });
  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: HEAD, conclusion: 'success', evidenceRef: 'ci:1' } });
  if (state.auditRequired) state = applyOperationalEvent(state, { type: 'audit-result', result: { candidateSha: HEAD, decision: 'approved', evidenceRef: 'audit:1' } });
  return state;
}

function snapshot(state) {
  return { head: state.materialHeadSha, ci: state.ciEvidence, audit: state.auditEvidence,
    implementation: state.implementationAttempts, auditAttempts: state.auditAttempts,
    auditRemediation: state.auditRemediationAttempts };
}

function recovery(state, evidence = hygiene(), sha = OLD) {
  return rearmUnknownTechnicalHygiene({ state,
    controller: { technicalHygiene: evidence, hygieneRunId: 123, auditRunId: 456, hygieneDispatchNonce: 'old', observability: { providerCalls: 3 } },
    run: { id: 123, conclusion: 'success', head_sha: sha }, currentControllerSha: CURRENT });
}

test('mixed evidence separates recoverable material, semantic material and telemetry', () => {
  assert.deepEqual(classifyUnknownHygieneEvidence(hygiene()), {
    recoverableMaterial: [infrastructure], semanticMaterial: [semantic], nonMaterial: [telemetry]
  });
});

test('mixed recovery retains the full prior evidence and exact-head CI/audit/counters', () => {
  const before = pending();
  const previous = hygiene();
  const { state, controller } = recovery(before, previous);
  assert.deepEqual(snapshot(state), snapshot(before));
  assert.equal(state.status, 'technical-hygiene-pending');
  assert.equal(controller.auditRunId, 456);
  assert.equal(controller.observability.providerCalls, 3);
  assert.equal(controller.hygieneRunId, null);
  assert.notEqual(controller.hygieneDispatchNonce, 'old');
  assert.deepEqual(controller.hygieneRecovery.previousTechnicalHygiene, previous);
  assert.deepEqual(previous.missingEvidence, [infrastructure, semantic, telemetry]);
  const context = JSON.parse(legacyTechnicalHygieneContext({ materialHeadSha: HEAD, baselineSha: BASE,
    profile: state.riskProfile, previousTechnicalHygiene: controller.hygieneRecovery.previousTechnicalHygiene }));
  assert.equal(context.materialSha, HEAD);
  assert.equal(context.mutationAllowed, false);
  assert.deepEqual(context.previousTechnicalHygiene.missingEvidence, previous.missingEvidence);
  const persistent = persistentStateFromOperational({ state, identity, classifier, workflowChecks });
  const reconciled = reconcilePersistentState(persistent, { repository: state.repository,
    pullRequestNumber: 468, headRef: identity.headRef, baseSha: BASE, remoteHeadSha: HEAD });
  assert.equal(reconciled.nextAction, 'resolve-technical-hygiene');
  assert.deepEqual(snapshot(operationalStateFromPersistent(reconciled.state)), snapshot(before));
});

for (const risk of ['standard', 'critical']) {
  test(`${risk}: persistent semantic UNKNOWN escalates without spending CI/audit budgets or attempting release`, () => {
    const before = pending(risk);
    let { state } = recovery(before, hygiene('UNKNOWN', [infrastructure, semantic], risk));
    state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: hygiene('UNKNOWN', [semantic], risk) });
    assert.equal(nextOperationalAction(state), 'resolve-technical-hygiene');
    assert.equal(evaluateOperationalRelease({ state, releaseInput: {} }).readiness, false);
    state = applyOperationalEvent(state, { type: 'resolve-technical-hygiene' });
    assert.equal(state.status, 'escalated');
    assert.equal(state.terminalReason, 'technical-hygiene-unknown');
    assert.equal(state.escalation.evidenceRef, 'artifact:hygiene');
    assert.deepEqual(state.technicalHygiene.missingEvidence, [semantic]);
    assert.deepEqual(snapshot(state), snapshot(before));
    const persistent = persistentStateFromOperational({ state, identity, classifier, workflowChecks });
    assert.equal(operationalStateFromPersistent(persistent).status, 'escalated');
  });
}

for (const result of ['PASS', 'PASS_WITH_DEBT']) {
  test(`mixed recollection ${result} permits release with unchanged material identity`, () => {
    const before = pending();
    let { state } = recovery(before);
    state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: hygiene(result, []) });
    state = applyOperationalEvent(state, { type: 'resolve-technical-hygiene' });
    assert.equal(nextOperationalAction(state), 'evaluate-release-gate');
    assert.deepEqual(snapshot(state), snapshot(before));
    const release = evaluateOperationalRelease({ state, releaseInput: {
      schemaVersion: 1, repository: 'owner/repo', pullRequestNumber: 468, materialHeadSha: HEAD, currentRemoteHeadSha: HEAD,
      evidenceCollection: { materialHeadSha: HEAD, remoteHeadSha: HEAD, evidenceRef: 'collection' },
      classifier: { subjectSha: HEAD, profile: 'standard', version: 'v1', fingerprint: 'x', expectedFingerprint: 'x', evidenceRef: 'classifier' },
      checks: [{ name: 'CI', required: true, subjectSha: HEAD, status: 'completed', conclusion: 'success', workflowRunId: 1, evidenceRef: 'ci:1' }],
      audit: { candidateSha: HEAD, decision: 'approved', mode: state.auditMode, requestFingerprint: 'audit-fingerprint', evidenceRef: 'audit:1' },
      unresolvedFindings: [], blockers: []
    } });
    assert.equal(release.readiness, true);
  });
}

test('same-SHA, unknown provenance, pure semantics and non-material infrastructure cannot rearm', () => {
  assert.equal(recovery(pending(), hygiene(), CURRENT), null);
  assert.equal(recovery(pending(), hygiene(), ''), null);
  assert.equal(recovery(pending(), hygiene('UNKNOWN', [semantic])), null);
  assert.equal(recovery(pending(), hygiene('UNKNOWN', [semantic, telemetry])), null);
  assert.equal(shouldRearmUnknownTechnicalHygiene({ technicalHygiene: hygiene('UNKNOWN', [infrastructure]),
    runConclusion: 'success', runHeadSha: OLD, currentControllerSha: CURRENT }), true);
});

test('legacy ready state cannot outrank persisted mixed UNKNOWN', () => {
  const persistent = persistentStateFromOperational({ state: { ...pending(), status: 'ready-for-human-merge' }, identity, classifier, workflowChecks });
  let state = operationalStateFromPersistent(persistent);
  assert.equal(state.status, 'technical-hygiene-pending');
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: hygiene() });
  assert.equal(nextOperationalAction(state), 'resolve-technical-hygiene');
  state = applyOperationalEvent(state, { type: 'resolve-technical-hygiene' });
  assert.equal(state.status, 'escalated');
  assert.equal(recovery(state, hygiene(), CURRENT), null);
  assert.equal(recovery(state).state.status, 'technical-hygiene-pending');
  assert.equal(recovery({ ...state, terminalReason: 'implementation-budget-exhausted' }), null);
});

test('FAST reevaluation promotes once and retains the head before semantic escalation', () => {
  let state = pending('fast');
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: hygiene('UNKNOWN', [semantic], 'fast') });
  assert.equal(state.technicalHygiene.promotionRequired, true);
  state = applyOperationalEvent(state, { type: 'promote-risk', plan: plan('standard') });
  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: hygiene('UNKNOWN', [semantic]) });
  assert.equal(state.technicalHygiene.promotionRequired, false);
  state = applyOperationalEvent(state, { type: 'resolve-technical-hygiene' });
  assert.equal(state.status, 'escalated');
  assert.equal(state.riskProfile, 'standard');
  assert.equal(state.materialHeadSha, HEAD);
  assert.equal(state.implementationAttempts, 1);
  assert.equal(state.auditAttempts, 0);
  assert.equal(state.auditRemediationAttempts, 0);
});

test('controller recollects mixed hygiene once, persists escalation and never requests release/audit/CI again', async (t) => {
  const repository = 'crgasparoto-br/training-system';
  const orchestrator = 'crgasparoto-br/delivery-orchestrator';
  const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const root = await mkdtemp(path.join(tmpdir(), 'dv2-208-test-'));
  const env = {
    TARGET_REPOSITORY: repository, TARGET_ISSUE: '208', BASE_BRANCH: 'develop',
    DELIVERY_AI_PROVIDER: 'codex', DELIVERY_RISK_PROFILE: 'standard', DELIVERY_V2_RESUME_PR: '468',
    GITHUB_REPOSITORY: orchestrator, ORCHESTRATOR_WORKER_REF: 'main', GITHUB_RUN_ID: '700',
    DELIVERY_GITHUB_READ_TOKEN: 'fixture', DELIVERY_GITHUB_WRITE_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture',
    CONTROLLER_RESULT_PATH: path.join(root, 'result.json')
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const before = { ...pending(), repository, status: 'ready-for-human-merge' };
  let envelope = {
    persistent: persistentStateFromOperational({ state: before, identity: { ...identity, baseRef: 'develop' }, classifier, workflowChecks }),
    controller: { controllerRunId: 699, auditRunId: 456, technicalHygiene: hygiene(), hygieneRunId: 123 }
  };
  const pr = { number: 468, state: 'open', title: '[delivery-v2] issue 208', body: 'Closes #208',
    user: { login: 'crgasparoto-br' }, author_association: 'OWNER',
    head: { ref: identity.headRef, sha: HEAD, repo: { full_name: repository } },
    base: { ref: 'develop', sha: BASE, repo: { full_name: repository } } };
  const updates = [];
  const statuses = [];
  const dispatches = [];
  const summary = { missingEvidence: [semantic], reuseDiscovery: [], structuralFindings: [] };
  await writeFile(path.join(root, 'agent-stdio.log'), JSON.stringify({ type: 'item.completed',
    item: { type: 'agent_message', text: `TECHNICAL_HYGIENE_JSON=${JSON.stringify(summary)}` } }));
  execFileSync('python3', ['-m', 'zipfile', '-c', 'agent.zip', 'agent-stdio.log'], { cwd: root });
  const zip = await readFile(path.join(root, 'agent.zip'));
  const json = (data) => new Response(JSON.stringify(data), { status: 200 });
  const run = (id, sha) => ({ id, head_sha: sha, head_branch: 'main', event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success', html_url: `https://github.com/${orchestrator}/actions/runs/${id}`,
    repository: { full_name: orchestrator }, path: '.github/workflows/delivery-v2-dispatch.yml' });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const parsed = new URL(url);
    const route = parsed.pathname;
    const method = options.method ?? 'GET';
    if (method === 'GET' && route === `/repos/${repository}/pulls/468`) return json(pr);
    if (method === 'GET' && route === `/repos/${repository}/pulls/468/files`) return json([{ filename: 'apps/web/src/components/Filter.tsx' }]);
    if (method === 'GET' && route.endsWith('/issues/468/comments')) return json([{ id: 99,
      user: { login: 'crgasparoto-br' }, author_association: 'OWNER',
      body: `<!-- delivery-v2-state -->\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`` }]);
    if (method === 'GET' && route.endsWith('/contents/.delivery-v2/lock.json')) return json({
      content: Buffer.from(JSON.stringify({ canonicalClassifierFingerprint: 'f'.repeat(64) })).toString('base64'), html_url: 'classifier' });
    if (method === 'PATCH' && route.endsWith('/issues/comments/99')) {
      envelope = JSON.parse(JSON.parse(options.body).body.match(/```json\n([\s\S]*?)\n```/)[1]);
      updates.push(envelope);
      return json({ id: 99 });
    }
    if (method === 'POST' && route === `/repos/${repository}/statuses/${HEAD}`) {
      statuses.push(JSON.parse(options.body));
      return json({});
    }
    if (method === 'GET' && /\/actions\/runs\/(699|700)$/.test(route)) return json(run(Number(route.split('/').at(-1)), currentSha));
    if (method === 'GET' && route.endsWith('/actions/runs/123')) return json(run(123, OLD));
    if (method === 'GET' && route.endsWith('/actions/runs/124')) return json(run(124, currentSha));
    if (method === 'POST' && route.endsWith('/delivery-v2-worker-codex-standard.lock.yml/dispatches')) {
      dispatches.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && route.endsWith('/delivery-v2-worker-codex-standard.lock.yml/runs')) return json({ workflow_runs:
      dispatches.length ? [{ ...run(124, currentSha), display_title: `Delivery V2 worker ${dispatches[0].inputs.dispatch_nonce}` }] : [] });
    if (method === 'GET' && route.endsWith('/actions/runs/124/artifacts')) return json({ artifacts: [{ name: 'agent', id: 125, archive_download_url: 'artifact:new-hygiene' }] });
    if (method === 'GET' && route.endsWith('/actions/artifacts/125/zip')) return new Response(zip);
    throw new Error(`unexpected request: ${method} ${url}`);
  });

  await main();
  assert.equal(dispatches.length, 1);
  const context = JSON.parse(dispatches[0].inputs.remediation_context);
  assert.equal(dispatches[0].inputs.target_ref, HEAD);
  assert.equal(dispatches[0].inputs.target_pr, '468');
  assert.deepEqual(context.previousTechnicalHygiene.missingEvidence, [infrastructure, semantic, telemetry]);
  assert.equal(context.mutationAllowed, false);
  assert(updates.every((item) => item.persistent.status !== 'ready-for-human-merge'));
  assert(updates.every((item) => JSON.stringify(item.persistent.workflowChecks) === JSON.stringify(workflowChecks)));
  assert.equal(envelope.persistent.status, 'escalated');
  assert.equal(envelope.controller.nextAction, 'human-escalation');
  assert.deepEqual(envelope.controller.technicalHygiene.missingEvidence, [semantic]);
  assert.deepEqual(envelope.persistent.attempts, { implementation: 1, audit: 1, auditRemediation: 0 });
  assert.equal(envelope.controller.auditRunId, 456);
  assert.equal(statuses.at(-1).state, 'failure');
  assert(!statuses.some((status) => status.state === 'success'));
  await main();
  assert.equal(dispatches.length, 1, 'same-SHA resume must not allocate another hygiene worker');
  assert.equal(JSON.parse(await readFile(env.CONTROLLER_RESULT_PATH, 'utf8')).status, 'escalated');
});
