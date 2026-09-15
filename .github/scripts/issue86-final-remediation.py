from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}: {old[:100]!r}')
    p.write_text(s.replace(old, new, 1))


# Compact structural register keeps created files and all structural identities.
p = Path('src/v2/technical-hygiene.mjs')
s = p.read_text()
s = s.replace("  const previousMaterialSha = input.previousMaterialSha == null ? null : sha(input.previousMaterialSha, 'previousMaterialSha');\n  normalizeLocalPolicy(input.localPolicy);",
              "  const previousMaterialSha = input.previousMaterialSha == null ? null : sha(input.previousMaterialSha, 'previousMaterialSha');\n  const createdFiles = evidence(input.createdFiles ?? [], 'createdFiles');\n  normalizeLocalPolicy(input.localPolicy);")
s = s.replace("    createdSymbols: Object.freeze(reuseDiscovery.filter((entry) => entry.decision === 'CREATE_NEW').map((entry) => entry.symbol)),\n    structuralFindings: Object.freeze(findings),",
              "    createdSymbols: Object.freeze(reuseDiscovery.filter((entry) => entry.decision === 'CREATE_NEW').map((entry) => entry.symbol)),\n    createdFiles,\n    structuralFindings: Object.freeze(findings),")
s = s.replace("    promotionRequired: value.promotionRequired === true,\n    missingEvidence: Object.freeze((value.missingEvidence ?? []).map((entry, index) => {",
              "    promotionRequired: value.promotionRequired === true,\n    reusedSymbols: evidence(value.reusedSymbols ?? [], 'technical hygiene result.reusedSymbols'),\n    extendedSymbols: evidence(value.extendedSymbols ?? [], 'technical hygiene result.extendedSymbols'),\n    createdSymbols: evidence(value.createdSymbols ?? [], 'technical hygiene result.createdSymbols'),\n    createdFiles: evidence(value.createdFiles ?? [], 'technical hygiene result.createdFiles'),\n    structuralFindings: Object.freeze((value.structuralFindings ?? []).map((entry, index) => normalizeFinding(entry, index, 'technical hygiene result.structuralFindings'))),\n    missingEvidence: Object.freeze((value.missingEvidence ?? []).map((entry, index) => {")
p.write_text(s)

replace_once('src/v2/gh-aw-hygiene-artifact.mjs',
             "      reuseDiscovery: summary.reuseDiscovery ?? [],\n      structuralFindings: summary.structuralFindings ?? [],",
             "      reuseDiscovery: summary.reuseDiscovery ?? [],\n      createdFiles: summary.createdFiles ?? [],\n      structuralFindings: summary.structuralFindings ?? [],")

replace_once('.github/workflows/shared/delivery-v2-worker-scope-guard.md',
             "The JSON payload must contain `reuseDiscovery`, `structuralFindings`, `semanticJudgments`, `deterministicReferences`, `missingEvidence`, and `semanticCalls`; every material semantic decision must carry reproducible evidence.",
             "The JSON payload must contain `reuseDiscovery`, `createdFiles`, `structuralFindings`, `semanticJudgments`, `deterministicReferences`, `missingEvidence`, and `semanticCalls`; `createdFiles` must list repository-relative files created by the current worker, and every material semantic decision must carry reproducible evidence.")

# Risk promotion is deterministic and cannot downgrade existing risk.
p = Path('src/v2/operational-controller.mjs')
s = p.read_text()
replace = "const SHA_RE = /^[0-9a-f]{40}$/i;\nconst RISK_RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });\nconst AI_POLICY_ENV_KEYS"
if "const RISK_RANK = Object.freeze({ fast: 1, standard: 2, critical: 3 });" not in s:
    s = s.replace("const SHA_RE = /^[0-9a-f]{40}$/i;\nconst AI_POLICY_ENV_KEYS", replace)
anchor = "function bindPlanAiIdentity(state, plan) {\n  const implementation = requiredObject(plan.implementation, 'plan.implementation');\n  const audit = requiredObject(plan.audit, 'plan.audit');\n  return Object.freeze({\n    ...state,\n    implementerProvider: requiredString(implementation.provider, 'plan.implementation.provider'),\n    implementerModel: requiredString(implementation.model, 'plan.implementation.model'),\n    auditorProvider: requiredString(audit.provider, 'plan.audit.provider'),\n    auditorModel: requiredString(audit.model, 'plan.audit.model')\n  });\n}\n"
addition = anchor + "\nfunction promoteOperationalRisk(state, plan) {\n  const value = requiredObject(plan, 'plan');\n  const profile = requiredString(value.risk?.profile, 'plan.risk.profile');\n  if (!(profile in RISK_RANK)) throw new Error(`unsupported promoted risk profile: ${profile}`);\n  if (RISK_RANK[profile] < RISK_RANK[state.riskProfile]) throw new Error('technical hygiene promotion cannot downgrade risk');\n  if (RISK_RANK[profile] === RISK_RANK[state.riskProfile]) return state;\n  const policy = executionPolicyFor(profile);\n  let next = Object.freeze({\n    ...state,\n    riskProfile: profile,\n    limits: Object.freeze({ maxImplementationAttempts: policy.maxImplementationAttempts, maxAuditRemediationAttempts: policy.maxAuditAttempts })\n  });\n  next = applyAuditPolicy(next, { repository: value.repository, audit: requiredObject(value.audit, 'plan.audit') });\n  return bindPlanAiIdentity(next, value);\n}\n"
if s.count(anchor) != 1:
    raise SystemExit('operational-controller: bindPlanAiIdentity anchor mismatch')
s = s.replace(anchor, addition, 1)
replace_once_text = "    case 'classify': return classifyDelivery(state, { riskProfile: value.riskProfile ?? state.riskProfile });\n    case 'start-implementation':"
if s.count(replace_once_text) != 1:
    raise SystemExit('operational-controller: classify event anchor mismatch')
s = s.replace(replace_once_text, "    case 'classify': return classifyDelivery(state, { riskProfile: value.riskProfile ?? state.riskProfile });\n    case 'promote-risk': return promoteOperationalRisk(state, requiredObject(value.plan, 'event.plan'));\n    case 'start-implementation':", 1)
p.write_text(s)

promotion_helper = '''async function ensurePromotedTechnicalHygiene({ hygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber, materialHeadSha, baselineSha, previousMaterialSha = null, actionsToken, targetReadToken }) {
  if (!hygiene?.promotionRequired) return { hygiene, state, plan, promotionRun: null };
  const promotedPlan = makePlan({ repository: targetRepository, issueNumber, provider, requestedRisk: 'standard', changedPaths, repositoryPolicy });
  let promotedState = applyOperationalEvent(state, { type: 'promote-risk', plan: promotedPlan });
  const dispatchNonce = createDispatchNonce();
  let promotionRun = await dispatchWorker({
    orchestratorRepository,
    orchestratorRef,
    plan: promotedPlan,
    controllerRunId,
    targetRepository,
    issueNumber,
    baseBranch,
    targetRef: materialHeadSha,
    targetPr: pullRequestNumber,
    remediationContext: JSON.stringify({ kind: 'technical-hygiene-evidence-promotion', evidenceOnly: true, materialSha: materialHeadSha, missingEvidence: hygiene.missingEvidence }),
    token: actionsToken,
    dispatchNonce
  });
  promotionRun = await waitWorkflowRun(orchestratorRepository, promotionRun.id, actionsToken);
  if (promotionRun.conclusion !== 'success') throw new Error(`technical hygiene STANDARD promotion worker failed: ${promotionRun.html_url}`);
  const currentPr = await fetchPullRequest(targetRepository, pullRequestNumber, targetReadToken);
  if (String(currentPr.head.sha).toLowerCase() !== materialHeadSha.toLowerCase()) throw new Error('technical hygiene evidence-only promotion mutated the material head');
  const reevaluated = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: promotionRun.id, token: actionsToken, baselineSha, materialSha: materialHeadSha, previousMaterialSha, profile: promotedState.riskProfile });
  promotedState = applyOperationalEvent(promotedState, { type: 'technical-hygiene-result', result: reevaluated });
  if (!['PASS', 'PASS_WITH_DEBT'].includes(reevaluated.result)) throw new Error(`technical hygiene remained ${reevaluated.result} after ${promotedState.riskProfile.toUpperCase()} re-evaluation`);
  return { hygiene: reevaluated, state: promotedState, plan: promotedPlan, promotionRun };
}
'''
for script in ['scripts/run-delivery-v2-controller.mjs', 'scripts/resume-delivery-v2-controller.mjs']:
    p = Path(script)
    s = p.read_text()
    marker = "function higherRisk(next, current) {\n  return RISK_RANK[next] > RISK_RANK[current];\n}\n"
    if s.count(marker) != 1:
        raise SystemExit(f'{script}: higherRisk anchor mismatch')
    s = s.replace(marker, marker + "\n" + promotion_helper, 1)
    p.write_text(s)

# Initial controller promotion and provider accounting.
p = Path('scripts/run-delivery-v2-controller.mjs')
s = p.read_text()
old = "  const initialTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: null, profile: state.riskProfile });\n  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: initialTechnicalHygiene });\n  evidenceRefs.push(initialTechnicalHygiene.evidenceRef);\n"
new = "  let initialTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: null, profile: state.riskProfile });\n  state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: initialTechnicalHygiene });\n  evidenceRefs.push(initialTechnicalHygiene.evidenceRef);\n  const initialPromotion = await ensurePromotedTechnicalHygiene({ hygiene: initialTechnicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: pullRequest.number, materialHeadSha, baselineSha: expectedBaseSha, actionsToken, targetReadToken });\n  if (initialPromotion.promotionRun) {\n    state = initialPromotion.state;\n    plan = initialPromotion.plan;\n    initialTechnicalHygiene = initialPromotion.hygiene;\n    workerRuns.push(initialPromotion.promotionRun);\n    const promotionUsage = await downloadWorkerUsage(orchestratorRepository, initialPromotion.promotionRun.id, actionsToken);\n    observability = recordControllerProviderObservation(observability, { runId: initialPromotion.promotionRun.id, stage: 'implementation', usage: promotionUsage.usage, evidenceRef: promotionUsage.evidenceRef ?? initialPromotion.promotionRun.html_url });\n    if (promotionUsage.evidenceRef) evidenceRefs.push(promotionUsage.evidenceRef);\n    evidenceRefs.push(initialTechnicalHygiene.evidenceRef);\n  }\n"
if s.count(old) != 1:
    raise SystemExit('run controller: initial hygiene anchor mismatch')
s = s.replace(old, new, 1)

old = "      const remediationTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });\n      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: remediationTechnicalHygiene });\n      evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);\n"
new = "      let remediationTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });\n      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: remediationTechnicalHygiene });\n      evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);\n      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: remediationTechnicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: pullRequest.number, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken });\n      if (hygienePromotion.promotionRun) {\n        state = hygienePromotion.state;\n        plan = hygienePromotion.plan;\n        remediationTechnicalHygiene = hygienePromotion.hygiene;\n        workerRuns.push(hygienePromotion.promotionRun);\n        const promotionUsage = await downloadWorkerUsage(orchestratorRepository, hygienePromotion.promotionRun.id, actionsToken);\n        observability = recordControllerProviderObservation(observability, { runId: hygienePromotion.promotionRun.id, stage: 'implementation', usage: promotionUsage.usage, evidenceRef: promotionUsage.evidenceRef ?? hygienePromotion.promotionRun.html_url });\n        if (promotionUsage.evidenceRef) evidenceRefs.push(promotionUsage.evidenceRef);\n        evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);\n      }\n"
if s.count(old) != 1:
    raise SystemExit('run controller: CI remediation hygiene anchor mismatch')
s = s.replace(old, new, 1)

old = "        state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });\n        latestCheck = null;\n        latestSourceRun = null;\n        lastAudit = null;\n        await persist({ nextAction: 'observe-ci', workerRunId: worker.id, workerDispatchNonce: null, materialWorkerRunId: worker.id, materialWorkerIdentity: plan.implementation.workflow, materialWorkerProvider: plan.implementation.provider, auditRunId: null, auditDispatchNonce: null, auditRequestFingerprint: null, priorFindings: (controller.priorFindings ?? []).map((finding) => ({ ...finding, status: 'remediated-pending-verification' })) });"
new = "        state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });\n        let remediationTechnicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });\n        state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: remediationTechnicalHygiene });\n        evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);\n        const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: remediationTechnicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: pullRequest.number, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken });\n        if (hygienePromotion.promotionRun) {\n          state = hygienePromotion.state;\n          plan = hygienePromotion.plan;\n          remediationTechnicalHygiene = hygienePromotion.hygiene;\n          workerRuns.push(hygienePromotion.promotionRun);\n          const promotionUsage = await downloadWorkerUsage(orchestratorRepository, hygienePromotion.promotionRun.id, actionsToken);\n          observability = recordControllerProviderObservation(observability, { runId: hygienePromotion.promotionRun.id, stage: 'implementation', usage: promotionUsage.usage, evidenceRef: promotionUsage.evidenceRef ?? hygienePromotion.promotionRun.html_url });\n          if (promotionUsage.evidenceRef) evidenceRefs.push(promotionUsage.evidenceRef);\n          evidenceRefs.push(remediationTechnicalHygiene.evidenceRef);\n        }\n        latestCheck = null;\n        latestSourceRun = null;\n        lastAudit = null;\n        await persist({ nextAction: 'observe-ci', workerRunId: worker.id, workerDispatchNonce: null, materialWorkerRunId: worker.id, materialWorkerIdentity: plan.implementation.workflow, materialWorkerProvider: plan.implementation.provider, technicalHygiene: state.technicalHygiene, auditRunId: null, auditDispatchNonce: null, auditRequestFingerprint: null, priorFindings: (controller.priorFindings ?? []).map((finding) => ({ ...finding, status: 'remediated-pending-verification' })) });"
if s.count(old) != 1:
    raise SystemExit('run controller: audit remediation anchor mismatch')
s = s.replace(old, new, 1)
p.write_text(s)

# Resume: attach technical hygiene to both material-producing remediation paths and promote FAST UNKNOWN.
p = Path('scripts/resume-delivery-v2-controller.mjs')
s = p.read_text()
old = "      const technicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: run.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });\n      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: technicalHygiene });\n      latestCheck = null;"
new = "      let technicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: run.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });\n      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: technicalHygiene });\n      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: technicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: resumePr, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken });\n      if (hygienePromotion.promotionRun) {\n        await recordWorkerUsage(hygienePromotion.promotionRun);\n        state = hygienePromotion.state;\n        plan = hygienePromotion.plan;\n        technicalHygiene = hygienePromotion.hygiene;\n      }\n      latestCheck = null;"
if s.count(old) != 1:
    raise SystemExit(f'resume controller: implementing hygiene anchor mismatch {s.count(old)}')
s = s.replace(old, new, 1)

old = "      state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });\n      latestCheck = null;\n      latestSourceRun = null;\n      await persist({ nextAction: 'observe-ci', ...controllerMetadataForNewMaterial({ controller, workerRunId: worker.id, plan }) });"
new = "      state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha });\n      let technicalHygiene = await downloadGhAwTechnicalHygieneArtifact({ repository: orchestratorRepository, runId: worker.id, token: actionsToken, baselineSha: expectedBaseSha, materialSha: materialHeadSha, previousMaterialSha: beforeSha, profile: state.riskProfile });\n      state = applyOperationalEvent(state, { type: 'technical-hygiene-result', result: technicalHygiene });\n      const hygienePromotion = await ensurePromotedTechnicalHygiene({ hygiene: technicalHygiene, state, plan, repositoryPolicy, changedPaths, provider, orchestratorRepository, orchestratorRef, controllerRunId, targetRepository, issueNumber, baseBranch, pullRequestNumber: resumePr, materialHeadSha, baselineSha: expectedBaseSha, previousMaterialSha: beforeSha, actionsToken, targetReadToken });\n      if (hygienePromotion.promotionRun) {\n        await recordWorkerUsage(hygienePromotion.promotionRun);\n        state = hygienePromotion.state;\n        plan = hygienePromotion.plan;\n        technicalHygiene = hygienePromotion.hygiene;\n      }\n      latestCheck = null;\n      latestSourceRun = null;\n      await persist({ nextAction: 'observe-ci', ...controllerMetadataForNewMaterial({ controller, workerRunId: worker.id, plan }), technicalHygiene: state.technicalHygiene });"
if s.count(old) != 1:
    raise SystemExit(f'resume controller: generic remediation anchor mismatch {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# Correct invalid state-machine tests and cover risk promotion + created-files register.
p = Path('test/v2-operational-controller.test.mjs')
s = p.read_text()
identity_anchor = "function identity(provider = 'codex') {\n  return { issueNumber: 63, pullRequestNumber: 77, baseRef: 'main', baseSha: B, headRef: 'feat/63', provider };\n}\n"
fast_helper = identity_anchor + "\nfunction fastPlanFor() {\n  return createDeliveryPlan({ requestedRisk: 'fast', changedPaths: ['apps/web/src/components/Filter.tsx'], repositoryPolicy: { fastSafeRoots: ['apps/web/src/components'] }, repository: 'owner/repo', issueNumber: 63, aiPolicy: { implementerProvider: 'codex', implementerModel: 'gpt-5.4', auditorProvider: 'claude', auditorModel: 'claude-opus-5' } });\n}\n"
if s.count(identity_anchor) != 1:
    raise SystemExit('operational test identity anchor mismatch')
s = s.replace(identity_anchor, fast_helper, 1)
s = s.replace("createOperationalDelivery({ plan: planFor('fast'), materialHeadSha: A })", "createOperationalDelivery({ plan: fastPlanFor(), materialHeadSha: A })")
old = "  state = applyOperationalEvent(state, { type: 'start-implementation' });\n  state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha: B });"
new = "  state = applyOperationalEvent(state, { type: 'ci-result', result: { candidateSha: A, conclusion: 'failure', failureClass: 'actionable', cause: 'test-remediation', evidenceRef: 'run:failed' } });\n  state = applyOperationalEvent(state, { type: 'start-implementation' });\n  state = applyOperationalEvent(state, { type: 'publish-material', materialHeadSha: B });"
if s.count(old) != 1:
    raise SystemExit('operational test remediation anchor mismatch')
s = s.replace(old, new, 1)
s += "\n\ntest('technical hygiene promotion upgrades FAST operational risk to STANDARD', () => {\n  let state = createOperationalDelivery({ plan: fastPlanFor(), materialHeadSha: A });\n  const promotedPlan = createDeliveryPlan({ requestedRisk: 'standard', changedPaths: ['apps/web/src/components/Filter.tsx'], repositoryPolicy: { fastSafeRoots: ['apps/web/src/components'] }, repository: 'owner/repo', issueNumber: 63, aiPolicy: { implementerProvider: 'codex', implementerModel: 'gpt-5.4', auditorProvider: 'claude', auditorModel: 'claude-opus-5' } });\n  state = applyOperationalEvent(state, { type: 'promote-risk', plan: promotedPlan });\n  assert.equal(state.riskProfile, 'standard');\n  assert.equal(state.auditRequired, true);\n});\n"
p.write_text(s)

p = Path('test/v2-technical-hygiene.test.mjs')
s = p.read_text()
s += "\n\ntest('compact structural register preserves created files and symbols',()=>{const r=evaluateTechnicalHygiene(base({createdFiles:['src/new-helper.mjs'],reuseDiscovery:[{symbol:'NewHelper',decision:'CREATE_NEW',material:true,evidence:ev('new'),justificationEvidence:ev('owner')}]}));assert.deepEqual(r.createdFiles,['src/new-helper.mjs']);assert.deepEqual(r.createdSymbols,['NewHelper'])});\n"
p.write_text(s)
