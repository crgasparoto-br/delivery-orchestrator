import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateReentry, persistReentryMutation, terminalBootstrapLease } from '../scripts/guard-delivery-v2-reentry.mjs';
import { auditProducerInputs, legacyTechnicalHygieneContext, persistLegacyRefreeze } from '../scripts/resume-delivery-v2-controller.mjs';
import { createDeliveryPlan } from '../src/v2/delivery-plan.mjs';
import { buildClassifierPackage } from '../src/v2/classifier-distribution.mjs';
import { normalizePersistentDeliveryState } from '../src/v2/persistent-state.mjs';
import { evaluateOperationalRelease } from '../src/v2/operational-controller.mjs';
import { AUDIT_CONTINUATION_MARKER, LEGACY_ADOPTION_MARKER, attachLegacyAdoptionAuditRun, createLegacyAdoption, legacyAdoptionComment, normalizeLegacyAdoption, parseAuditContinuation, parseLegacyAdoptionEnvelope, recordLegacyAdoptionAuditResult, refreezeLegacyAdoption, reserveLegacyAdoptionAudit, validateLegacyAdoptionControllerRun } from '../src/v2/legacy-adoption.mjs';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/issue-105-existing-pr.json', import.meta.url), 'utf8'));
const pr = snapshot.solverFin613.pullRequest;
const repository = 'crgasparoto-br/SolverFin';
const input = { pullRequest: pr, repository, issueNumber: 613, baseBranch: 'main' };
const controller = { controllerRunId: 35048673202, controllerRepository: 'crgasparoto-br/delivery-orchestrator', controllerRef: 'main', controllerWorkflowPath: '.github/workflows/delivery-v2-dispatch.yml' };
const bootstrap = { schemaVersion: 1, repository, issueNumber: 613, baseBranch: 'main', implementationAttempts: 3, commentId: 10, controllerRunId: 35048673202, status: 'reserved-initial-attempt', provider: 'codex', model: 'gpt-5.6-sol', effectiveRisk: 'critical' };
const targetPolicy = JSON.parse(readFileSync(new URL('../config/delivery-v2-controller-targets.json', import.meta.url), 'utf8')).targets[repository];

function comment(marker, value, overrides = {}) {
  return { id: 101, user: { login: 'crgasparoto-br' }, author_association: 'OWNER', body: `${marker}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, ...overrides };
}
function continuation(record, overrides = {}) {
  return comment(AUDIT_CONTINUATION_MARKER, {
    schemaVersion: 1, repository, issueNumber: 613, pullRequestNumber: 660,
    baseRef: record.baseRef, baseSha: record.baseSha, headRef: record.headRef, materialHeadSha: record.materialHeadSha,
    ...snapshot.solverFin613.continuation, reuseExactHeadCi: true, ...overrides
  });
}
function evidence({ bootstrapLease = bootstrap, changedPaths = ['apps/web/src/budgets.ts'], repositoryPolicy = {} } = {}) {
  const record = createLegacyAdoption({ ...input, bootstrapLease });
  const plan = createDeliveryPlan({ repository, issueNumber: 613, requestedRisk: 'auto', changedPaths, repositoryPolicy });
  const distribution = buildClassifierPackage({ rootDir: fileURLToPath(new URL('../', import.meta.url)), sourceCommit: 'a'.repeat(40), targetConfig: { schemaVersion: 1, repository, baseBranch: 'main', riskPolicy: repositoryPolicy } });
  const classifier = { subjectSha: pr.head.sha, version: 'test-canonical-runtime', fingerprint: distribution.lock.canonicalClassifierFingerprint, policyFingerprint: distribution.lock.files['policy.json'] };
  const run = { id: 202, run_number: 1, name: targetPolicy.ciWorkflowName, path: targetPolicy.ciWorkflowPath, repository: { full_name: repository }, event: 'pull_request', head_sha: pr.head.sha, head_branch: pr.head.ref, status: 'completed', conclusion: 'success', check_suite_id: 303 };
  const check = { name: targetPolicy.requiredStatusName, head_sha: pr.head.sha, status: 'completed', conclusion: 'success', details_url: `https://github.com/${repository}/actions/runs/202/job/404`, app: { slug: 'github-actions' }, check_suite: { id: 303 } };
  return { record, pullRequest: structuredClone(pr), comments: [continuation(record)], checkoutHeadSha: pr.head.sha, plan, classifier, runs: [run], checks: [check], targetPolicy };
}

test('A/H: SolverFin #613/#660 adoption -> durable resume -> exact-head post-write-refreeze, without an initial attempt or provider call', async () => {
  const decision = evaluateReentry({ pullRequest: pr, bootstrapLease: bootstrap, targetRepository: repository, issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  assert.equal(decision.status, 'legacy-adopted');
  assert.equal(decision.resumePr, 660);
  assert.equal(decision.headRef, 'codex/613-budgets-multicurrency');
  assert.equal(decision.materialHeadSha, '70499851ee7a96734a447bc3de50f7da56b8bf50');
  assert.equal(decision.priorInitialAttempts, undefined);
  assert.equal(decision.recoverWorkerRunId, undefined);
  assert.deepEqual(decision.attempts, { implementation: 3, audit: null, auditRemediation: null });
  const mutations = [];
  await persistReentryMutation({ decision, repository, controller, getWriteToken: () => 'fake-write-token', mutate: async (url, token, options) => { mutations.push({ url, token, ...options }); } });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].method, 'POST');
  assert.equal(mutations[0].url, `https://api.github.com/repos/${repository}/issues/660/comments`);
  const stored = { ...comment(LEGACY_ADOPTION_MARKER, {}), body: JSON.parse(mutations[0].body).body };
  const envelope = parseLegacyAdoptionEnvelope([stored], repository);
  const saved = [];
  const result = await persistLegacyRefreeze({ ...evidence(), envelope, controller, observePullRequest: async () => pr, persist: async (body) => saved.push(body) });
  assert.equal(result.phase, 'post-write-refreeze');
  assert.equal(result.pullRequestNumber, 660);
  assert.equal(result.materialHeadSha, pr.head.sha);
  assert.equal(result.headRef, pr.head.ref);
  assert.equal(result.initialImplementationReserved, false);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.attempts.implementation, 3);
  assert.equal(result.adoption.workflowChecks[0].workflowRunId, 202);
  assert.equal(result.adoption.workflowChecks[0].evidenceRef, evidence().checks[0].details_url);
  assert.equal(result.adoption.auditEvidence, null);
  assert.equal(result.releaseReady, false);
  assert.equal(parseLegacyAdoptionEnvelope([{ ...stored, body: saved[0] }], repository).adoption.phase, 'post-write-refreeze');
  const resumed = evaluateReentry({ pullRequest: pr, adoptionEnvelope: parseLegacyAdoptionEnvelope([{ ...stored, body: saved[0] }], repository), targetRepository: repository, issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  assert.equal(resumed.resumePr, 660);
  assert.equal(resumed.status, 'legacy-adopted');
  assert.deepEqual(resumed.attempts, result.attempts);
  assert.throws(() => evaluateOperationalRelease({ state: result.adoption }), /unsupported Delivery V2 state/);
});

test('J / DV2-105-ADOPT-SYNTHETIC-CLASSIFIER: adoption without any prior V2 state retains UNKNOWN instead of synthetic risk, classifier or counters', () => {
  const record = createLegacyAdoption(input);
  assert.deepEqual(createLegacyAdoption({ ...input, pullRequest: { ...pr, title: '[delivery-v2] A pre-existing PR' } }), record);
  assert.equal(record.status, 'legacy-adopted');
  assert.equal(record.classifier, null);
  assert.equal(record.effectiveRisk, null);
  assert.deepEqual(record.attempts, { implementation: null, audit: null, auditRemediation: null });
  assert.equal(record.legacyAdoptionAuditAttempts, 0);
  assert.equal(record.legacyAdoptionAuditMaxAttempts, 1);
  assert.equal(record.legacyAudit, null);
  assert.deepEqual(record.workflowChecks, []);
  assert.equal(record.auditEvidence, null);
  assert.equal(record.adoption.source, 'github-open-pull-request');
  assert.equal(record.adoption.evidenceRef, `https://github.com/${repository}/pull/660`);
  assert.equal(record.adoption.adoptedHeadSha, pr.head.sha);
  assert.equal(record.adoption.adoptedBaseSha, pr.base.sha);
  assert.equal(record.adoption.attemptEvidenceRef, null);
  assert.throws(() => normalizePersistentDeliveryState(record), /effectiveRisk/);
  const fast = refreezeLegacyAdoption(evidence({ bootstrapLease: null, changedPaths: ['docs/guide.md'], repositoryPolicy: { fastSafeRoots: ['docs'] } }));
  assert.equal(fast.phase, 'post-write-refreeze');
  assert.equal(fast.effectiveRisk, 'fast', 'real canonical classification, not hardcoded critical');
  assert.equal(fast.classifier.current, true);
  assert.notEqual(fast.classifier.fingerprint, pr.head.sha);
  assert.equal(fast.classifier.fingerprint.length, 64);
  assert.deepEqual(fast.attempts, record.attempts);
  assert.throws(() => refreezeLegacyAdoption({ ...evidence(), classifier: { subjectSha: pr.head.sha, version: 'synthetic', fingerprint: pr.head.sha } }), /real exact-head classifier/);
  const missingPaths = evidence();
  missingPaths.plan.risk.provisional = true;
  assert.throws(() => refreezeLegacyAdoption(missingPaths), /exact changed-path classification/);
});

test('B/C/D/E/F: positive adoption cannot bypass the shared identity boundary', () => {
  for (const patch of [
    { user: { login: 'another-member' }, author_association: 'MEMBER' },
    { user: { login: 'another-collaborator' }, author_association: 'COLLABORATOR' },
    { state: undefined }, { state: 'closed' },
    { head: { ...pr.head, repo: { full_name: 'other/fork' } } },
    { base: { ...pr.base, ref: 'develop' } },
    { head: { ...pr.head, ref: '' } }, { head: { ...pr.head, sha: '' } },
    { base: { ...pr.base, sha: '' } }
  ]) assert.throws(() => createLegacyAdoption({ ...input, pullRequest: { ...pr, ...patch } }));
  // D is additionally exercised against the complete candidate set by v2-existing-pr-identity.
});

test('G: head/base drift invalidates continuation and CI before refreeze without resetting history', () => {
  for (const side of ['head', 'base']) {
    const data = evidence();
    data.pullRequest[side].sha = 'f'.repeat(40);
    data.checkoutHeadSha = data.pullRequest.head.sha;
    const changed = refreezeLegacyAdoption(data);
    assert.equal(changed.phase, 'blocked');
    assert.deepEqual(changed.workflowChecks, []);
    assert.equal(changed.classifier, null);
    assert.equal(changed.continuation, null);
    assert.deepEqual(changed.attempts, data.record.attempts);
    assert.equal(changed.adoption.adoptedHeadSha, pr.head.sha);
  }
});

test('G: head drift during evidence collection is persisted as blocked instead of a stale frozen candidate', async () => {
  let written;
  const data = evidence();
  const result = await persistLegacyRefreeze({ ...data, envelope: { adoption: data.record }, controller,
    observePullRequest: async () => ({ ...pr, head: { ...pr.head, sha: 'f'.repeat(40) } }), persist: async (body) => { written = body; }
  });
  assert.equal(result.phase, 'blocked');
  assert.deepEqual(result.adoption.workflowChecks, []);
  assert.equal(result.adoption.classifier, null);
  assert.ok(written.includes('adoption-identity-drift'));
  assert.equal(result.adoption.attempts.implementation, 3);
});

test('G: a stale adoption can refreeze the new head only after fresh checkout, continuation, classification and exact-head CI', () => {
  const data = evidence();
  data.pullRequest.head.sha = 'f'.repeat(40);
  const blocked = refreezeLegacyAdoption(data);
  assert.equal(blocked.phase, 'blocked');
  data.record = blocked;
  data.checkoutHeadSha = data.pullRequest.head.sha;
  data.comments = [continuation(blocked)];
  data.classifier.subjectSha = data.pullRequest.head.sha;
  data.runs[0].head_sha = data.pullRequest.head.sha;
  data.checks[0].head_sha = data.pullRequest.head.sha;
  const recovered = refreezeLegacyAdoption(data);
  assert.equal(recovered.phase, 'post-write-refreeze');
  assert.equal(recovered.materialHeadSha, 'f'.repeat(40));
  assert.equal(recovered.workflowChecks[0].subjectSha, recovered.materialHeadSha);
  assert.deepEqual(recovered.attempts, data.record.attempts);
  assert.equal(recovered.adoption.adoptedHeadSha, pr.head.sha);
});

test('H/I: CI reuse requires exact SHA, trusted run/check correlation, latest run and explicit continuation permission', () => {
  for (const mutate of [
    (data) => { data.runs[0].head_sha = 'a'.repeat(40); },
    (data) => { data.checks[0].head_sha = 'a'.repeat(40); },
    (data) => { data.checks[0].conclusion = 'failure'; },
    (data) => { data.runs[0].status = 'in_progress'; },
    (data) => { data.runs[0].conclusion = 'failure'; },
    (data) => { data.runs[0].path = '.github/workflows/untrusted.yml'; },
    (data) => { data.runs[0].repository.full_name = 'other/repo'; },
    (data) => { data.checks[0].check_suite.id = 999; },
    (data) => { data.checks[0].app.slug = 'untrusted'; },
    (data) => { data.checks[0].details_url = `https://github.com/${repository}/actions/runs/999/job/1`; },
    (data) => { data.comments = [continuation(data.record, { reuseExactHeadCi: false })]; },
    (data) => { data.runs.push({ ...data.runs[0], id: 999, run_number: 2, status: 'in_progress', conclusion: null }); }
  ]) {
    const data = evidence();
    mutate(data);
    const blocked = refreezeLegacyAdoption(data);
    assert.equal(blocked.phase, 'blocked', mutate.toString());
    assert.equal(blocked.nextAction, 'observe-ci');
    assert.deepEqual(blocked.workflowChecks, []);
  }
  const data = evidence();
  assert.throws(() => refreezeLegacyAdoption({ ...data, checks: [...data.checks, data.checks[0]] }), /ambiguous required check/);
});

test('issue 254: trusted controller dispatch can continue legacy adoption without a manual continuation comment', async () => {
  const data = evidence();
  data.comments = [];
  const controllerContinuation = {
    repository,
    issueNumber: 613,
    pullRequestNumber: 660,
    baseRef: data.record.baseRef,
    baseSha: data.record.baseSha,
    headRef: data.record.headRef,
    materialHeadSha: data.record.materialHeadSha,
    reason: 'handoff-stale',
    recovery_scope: 'post-write-refreeze',
    requires_refreeze: true,
    next_phase: 'finalize-after-ci',
    reuseExactHeadCi: true,
    evidenceRef: `https://github.com/${controller.controllerRepository}/actions/runs/${controller.controllerRunId}`
  };

  const result = await persistLegacyRefreeze({
    ...data,
    envelope: { adoption: data.record },
    controller,
    controllerContinuation,
    observePullRequest: async () => pr,
    persist: async () => {}
  });

  assert.equal(result.phase, 'post-write-refreeze');
  assert.equal(result.adoption.continuation.evidenceRef, controllerContinuation.evidenceRef);
  assert.equal(result.adoption.nextAction, 'dispatch-legacy-adoption-audit');

  const blocked = refreezeLegacyAdoption({
    ...data,
    runs: [],
    checks: [],
    controllerContinuation
  });
  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.nextAction, 'observe-ci');

  const stale = refreezeLegacyAdoption({
    ...data,
    controllerContinuation: { ...controllerContinuation, materialHeadSha: 'f'.repeat(40) }
  });
  assert.equal(stale.phase, 'blocked');
  assert.match(stale.blockers[0], /controller continuation stale or mismatched materialHeadSha/);
});

test('continuation must be one explicitly trusted, exact-identity JSON record, never arbitrary audit prose or approval', () => {
  const data = evidence();
  assert.equal(parseAuditContinuation([], data.record), null);
  assert.equal(refreezeLegacyAdoption({ ...data, comments: [] }).phase, 'blocked');
  for (const patch of [{ issueNumber: 614 }, { pullRequestNumber: 661 }, { headRef: 'other' }, { repository: 'other/repo' }, { reason: 'approved' }, { requires_refreeze: false }, { reuseExactHeadCi: undefined }]) {
    assert.equal(refreezeLegacyAdoption({ ...data, comments: [continuation(data.record, patch)] }).phase, 'blocked');
  }
  assert.equal(refreezeLegacyAdoption({ ...data, comments: [...data.comments, ...data.comments] }).phase, 'blocked');
  assert.equal(refreezeLegacyAdoption({ ...data, comments: [{ ...data.comments[0], user: { login: 'member' }, author_association: 'MEMBER' }] }).phase, 'blocked');
  assert.equal(refreezeLegacyAdoption({ ...data, checkoutHeadSha: 'a'.repeat(40) }).phase, 'blocked');
});

test('attempt provenance is preserved, never defaulted, decremented or consumed by adopting/refreezing', () => {
  const data = evidence();
  assert.equal(data.record.attempts.implementation, 3);
  assert.equal(refreezeLegacyAdoption(data).attempts.implementation, 3);
  assert.match(data.record.adoption.attemptEvidenceRef, /issues\/613#issuecomment-10$/);
  for (const patch of [{ issueNumber: 614 }, { commentId: null }, { controllerRunId: null }, { implementationAttempts: undefined }, { implementationAttempts: -1 }]) {
    assert.throws(() => createLegacyAdoption({ ...input, bootstrapLease: { ...bootstrap, ...patch } }));
  }
  const altered = structuredClone(data.record);
  altered.attempts.audit = 0;
  assert.throws(() => normalizeLegacyAdoption(altered), /cannot infer historical audit/);
});

test('issue 149: pre-149 persisted adoption checkpoints upgrade in memory without fabricating historical counters', () => {
  const historical = refreezeLegacyAdoption(evidence());

  delete historical.legacyAdoptionAuditAttempts;
  delete historical.legacyAdoptionAuditMaxAttempts;
  delete historical.legacyAudit;

  const normalized = normalizeLegacyAdoption(historical);

  assert.equal(normalized.phase, 'post-write-refreeze');
  assert.equal(normalized.legacyAdoptionAuditAttempts, 0);
  assert.equal(normalized.legacyAdoptionAuditMaxAttempts, 1);
  assert.equal(normalized.legacyAudit, null);
  assert.equal(normalized.attempts.audit, null);
  assert.equal(normalized.attempts.auditRemediation, null);
});

test('issue 149: post-adoption audit uses a separate bounded idempotent budget without fabricating historical counters', () => {
  const frozen = refreezeLegacyAdoption(evidence());

  assert.equal(frozen.phase, 'post-write-refreeze');
  assert.equal(frozen.nextAction, 'dispatch-legacy-adoption-audit');
  assert.equal(frozen.attempts.audit, null);
  assert.equal(frozen.attempts.auditRemediation, null);
  assert.equal(frozen.legacyAdoptionAuditAttempts, 0);

  const reserved = reserveLegacyAdoptionAudit(frozen, { dispatchNonce: 'legacy-audit-nonce-1' });

  assert.equal(reserved.legacyAdoptionAuditAttempts, 1);
  assert.equal(reserved.attempts.audit, null);
  assert.equal(reserved.attempts.auditRemediation, null);
  assert.equal(reserved.legacyAudit.candidateSha, pr.head.sha);
  assert.equal(reserved.legacyAudit.dispatchNonce, 'legacy-audit-nonce-1');
  assert.equal(reserved.legacyAudit.runId, null);
  assert.equal(reserved.nextAction, 'resolve-legacy-adoption-audit-run');

  assert.deepEqual(
    reserveLegacyAdoptionAudit(reserved, { dispatchNonce: 'legacy-audit-nonce-1' }),
    reserved,
    'same nonce must be idempotent'
  );

  const bound = attachLegacyAdoptionAuditRun(reserved, {
    dispatchNonce: 'legacy-audit-nonce-1',
    runId: 9001
  });

  assert.equal(bound.legacyAudit.runId, 9001);
  assert.equal(bound.nextAction, 'observe-legacy-adoption-audit');

  assert.deepEqual(
    attachLegacyAdoptionAuditRun(bound, {
      dispatchNonce: 'legacy-audit-nonce-1',
      runId: 9001
    }),
    bound,
    'same run binding must be idempotent'
  );

  const approved = recordLegacyAdoptionAuditResult(bound, {
    runId: 9001,
    candidateSha: pr.head.sha,
    decision: 'approved',
    requestFingerprint: 'a'.repeat(64),
    evidenceRef: 'https://github.com/crgasparoto-br/delivery-orchestrator/actions/runs/9001',
    findings: []
  });

  assert.equal(approved.legacyAudit.decision, 'approved');
  assert.equal(approved.attempts.audit, null);
  assert.equal(approved.attempts.auditRemediation, null);
  assert.equal(approved.blockers.includes('independent-audit-required'), false);
  assert.equal(approved.nextAction, 'collect-technical-hygiene-evidence');

  assert.throws(
    () => reserveLegacyAdoptionAudit({ ...frozen, legacyAdoptionAuditAttempts: 1 }, { dispatchNonce: 'legacy-audit-nonce-2' }),
    /budget exhausted/
  );
});

test('issue 149: rejected legacy audit routes to bounded remediation and head drift invalidates its evidence without resetting budget', () => {
  const frozen = refreezeLegacyAdoption(evidence());
  const reserved = reserveLegacyAdoptionAudit(frozen, { dispatchNonce: 'legacy-audit-nonce-2' });
  const bound = attachLegacyAdoptionAuditRun(reserved, {
    dispatchNonce: 'legacy-audit-nonce-2',
    runId: 9002
  });

  const rejected = recordLegacyAdoptionAuditResult(bound, {
    runId: 9002,
    candidateSha: pr.head.sha,
    decision: 'rejected',
    requestFingerprint: 'b'.repeat(64),
    evidenceRef: 'https://github.com/crgasparoto-br/delivery-orchestrator/actions/runs/9002',
    findings: [{
      id: 'DV2-149-TEST',
      candidateSha: pr.head.sha,
      blocksRelease: true
    }]
  });

  assert.equal(rejected.legacyAudit.decision, 'rejected');
  assert.equal(rejected.nextAction, 'dispatch-legacy-adoption-audit-remediation');
  assert.equal(rejected.blockers.includes('independent-audit-rejected'), true);
  assert.equal(rejected.legacyAdoptionAuditAttempts, 1);

  const drift = evidence();
  drift.record = rejected;
  drift.pullRequest.head.sha = 'f'.repeat(40);
  drift.checkoutHeadSha = drift.pullRequest.head.sha;

  const invalidated = refreezeLegacyAdoption(drift);

  assert.equal(invalidated.phase, 'blocked');
  assert.equal(invalidated.legacyAudit, null);
  assert.equal(invalidated.legacyAdoptionAuditAttempts, 1);
  assert.equal(invalidated.attempts.audit, null);
  assert.equal(invalidated.attempts.auditRemediation, null);
});

test('issue 149: audit dispatch declares legacy producer unknown until a V2 remediation creates new material', () => {
  const legacy = auditProducerInputs({
    state: {
      implementationAttempts: 0,
      auditRemediationAttempts: 0
    },
    controller: {
      adoption: {
        type: 'legacy-adopted-post-refreeze'
      },
      materialWorkerRunId: null,
      materialWorkerIdentity: null,
      materialWorkerProvider: null
    },
    provider: 'codex',
    plan: {
      implementation: {
        workflow: 'delivery-v2-worker-codex-critical.yml'
      }
    }
  });

  assert.deepEqual(legacy, {
    implementation_attempt: '',
    implementer_provenance: 'legacy-unknown',
    implementer_provider: '',
    implementer_worker_identity: '',
    implementer_run_id: ''
  });

  const remediated = auditProducerInputs({
    state: {
      implementationAttempts: 0,
      auditRemediationAttempts: 1
    },
    controller: {
      adoption: {
        type: 'legacy-adopted-post-refreeze'
      },
      materialWorkerRunId: 9010,
      materialWorkerIdentity: 'delivery-v2-worker-codex-critical.yml',
      materialWorkerProvider: 'codex'
    },
    provider: 'codex',
    plan: {
      implementation: {
        workflow: 'delivery-v2-worker-codex-critical.yml'
      }
    }
  });

  assert.deepEqual(remediated, {
    implementation_attempt: '1',
    implementer_provenance: 'known',
    implementer_provider: 'codex',
    implementer_worker_identity: 'delivery-v2-worker-codex-critical.yml',
    implementer_run_id: '9010'
  });
});

test('issue 149: technical hygiene collection is explicitly evidence-only and exact-head bound', () => {
  const context = JSON.parse(legacyTechnicalHygieneContext({
    materialHeadSha: pr.head.sha,
    baselineSha: pr.base.sha,
    profile: 'critical'
  }));

  assert.deepEqual(context, {
    kind: 'technical-hygiene-evidence-collection',
    evidenceOnly: true,
    materialSha: pr.head.sha,
    baselineSha: pr.base.sha,
    profile: 'critical',
    mutationAllowed: false
  });

  assert.throws(
    () => legacyTechnicalHygieneContext({
      materialHeadSha: 'invalid',
      baselineSha: pr.base.sha,
      profile: 'critical'
    }),
    /exact material SHA/
  );
});

test('budget exhaustion persists a terminal bootstrap lease and distinguishes infrastructure from unknown pre-material failures', async () => {
  const decision = evaluateReentry({ bootstrapLease: bootstrap, targetRepository: repository, issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  assert.equal(decision.status, 'escalated-initial-budget-exhausted');
  const original = { ...bootstrap, scopeBinding: { authorizedPaths: ['src/example.mjs'] } };
  const run = { id: 42, status: 'completed', conclusion: 'timed_out' };
  const terminal = terminalBootstrapLease(original, decision, run);
  assert.equal(terminal.failureClass, 'infrastructure');
  assert.equal(terminal.failureStage, 'pre-material');
  assert.equal(terminal.status, 'escalated-initial-budget-exhausted');
  assert.deepEqual(terminal.scopeBinding, original.scopeBinding);
  assert.equal(terminal.implementationAttempts, 3);
  assert.equal(terminalBootstrapLease(original, decision, { ...run, conclusion: 'failure' }).failureClass, 'unknown');
  let mutation;
  await persistReentryMutation({ decision, repository, bootstrapLease: original, recoveredWorkerRun: run, getWriteToken: () => 'fake', mutate: async (url, token, options) => { mutation = { url, ...options }; } });
  assert.match(mutation.url, /issues\/comments\/10$/);
  assert.equal(mutation.method, 'PATCH');
  assert.ok(JSON.parse(mutation.body).body.includes('escalated-initial-budget-exhausted'));
  assert.equal(await persistReentryMutation({ decision, repository, bootstrapLease: { ...terminal, commentId: 10 }, getWriteToken: () => { throw new Error('no write needed'); } }), false);
  const publishedLater = evaluateReentry({ pullRequest: { ...pr, title: '[delivery-v2] Existing publication' }, bootstrapLease: { ...terminal, commentId: 10 }, recoveredWorkerRun: { ...run, conclusion: 'success' }, targetRepository: repository, issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  assert.equal(publishedLater.status, 'legacy-adopted');
  assert.equal(publishedLater.resumePr, 660);
  assert.equal(publishedLater.attempts.implementation, 3);
});

test('L / DV2-105-GUARD-WRITE-TOKEN-UNCONDITIONAL: all read-only paths work without write capability', async () => {
  const rejectWrite = () => { throw new Error('unexpected write capability'); };
  const fresh = evaluateReentry({ targetRepository: repository, issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  assert.equal(fresh.status, 'new-delivery');
  assert.equal(await persistReentryMutation({ decision: fresh, repository, getWriteToken: rejectWrite }), false);
  const managed = evaluateReentry({ pullRequest: snapshot.issue105.pullRequest, stateEnvelope: snapshot.issue105.stateEnvelope, targetRepository: 'crgasparoto-br/delivery-orchestrator', issueNumber: 105, baseBranch: 'main', provider: 'codex' });
  assert.equal(managed.resumePr, 122);
  assert.equal(await persistReentryMutation({ decision: managed, repository, getWriteToken: rejectWrite }), false);
  const adopted = evaluateReentry({ pullRequest: pr, targetRepository: repository, issueNumber: 613, baseBranch: 'main', provider: 'codex' });
  await assert.rejects(() => persistReentryMutation({ decision: adopted, repository, controller, getWriteToken: rejectWrite }), /unexpected write capability/);
  assert.equal(await persistReentryMutation({ decision: adopted, adoptionEnvelope: { adoption: adopted.adoption, commentId: 1 }, repository, getWriteToken: rejectWrite }), false);
});

test('dispatcher checks out the immutable adopted PR head and the reserve/initial-plan guards exclude adoption', () => {
  const workflow = readFileSync(new URL('../.github/workflows/delivery-v2-dispatch.yml', import.meta.url), 'utf8');
  const checkout = workflow.slice(workflow.indexOf('- name: Checkout PR branch'), workflow.indexOf('- name: Reserve initial implementation attempt'));
  assert.match(checkout, /if: steps.reentry.outputs.status == 'legacy-adopted'/);
  assert.match(checkout, /ref: \$\{\{ steps.reentry.outputs.adoption_head \}\}/);
  assert.match(checkout, /persist-credentials: false/);
  for (const name of ['Reserve initial implementation attempt', 'Build initial deterministic plan']) {
    const step = workflow.slice(workflow.indexOf(`- name: ${name}`)).split('\n      - name:')[0];
    assert.match(step, /resume_pr == ''/);
  }
  assert.match(workflow, /DELIVERY_V2_ADOPTED_CHECKOUT: \$\{\{ github.workspace \}\}\/\.delivery-v2-adopted-pr/);
  const failureFinalizer = workflow.slice(workflow.indexOf('- name: Persist exhausted initial attempt')).split('\n      - name:')[0];
  assert.match(failureFinalizer, /failure\(\).*resume_pr == ''/);
  assert.match(failureFinalizer, /run: node scripts\/guard-delivery-v2-reentry.mjs/);
  const body = legacyAdoptionComment(createLegacyAdoption(input), controller);
  assert.equal(parseLegacyAdoptionEnvelope([{ ...comment(LEGACY_ADOPTION_MARKER, {}), body }], repository).adoption.materialHeadSha, pr.head.sha);
  assert.throws(() => parseLegacyAdoptionEnvelope([{ ...comment(LEGACY_ADOPTION_MARKER, {}), body, author_association: undefined }], repository), /untrusted legacy adoption/);
});

test('persisted adoption provenance must identify the trusted controller workflow, run and exact issue target', () => {
  const envelope = { adoption: createLegacyAdoption(input), controller };
  const run = { id: controller.controllerRunId, repository: { full_name: controller.controllerRepository }, path: controller.controllerWorkflowPath, head_branch: 'main', event: 'workflow_dispatch', display_title: `Delivery V2 controller ${repository} #613` };
  const expected = { orchestratorRepository: controller.controllerRepository, trustedRef: 'main' };
  assert.doesNotThrow(() => validateLegacyAdoptionControllerRun(envelope, run, expected));
  for (const patch of [{ id: 1 }, { path: '.github/workflows/untrusted.yml' }, { event: 'pull_request' }, { head_branch: 'untrusted' }, { display_title: `Delivery V2 controller ${repository} #614` }]) {
    assert.throws(() => validateLegacyAdoptionControllerRun(envelope, { ...run, ...patch }, expected));
  }
});
