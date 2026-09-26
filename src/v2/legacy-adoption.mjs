import { createHash } from 'node:crypto';
import { isTrustedRepositoryAuthor, parseTrustedJsonEnvelope, selectExistingPullRequest, trustedCommentAuthorForRepository, validateControllerRunProvenance } from './controller-provenance.mjs';
import { selectAuthoritativeSourceWorkflowRun, selectCheckForWorkflowRun } from './ci-evidence-correlation.mjs';

export const LEGACY_ADOPTION_MARKER = '<!-- delivery-v2-legacy-adoption -->';
export const AUDIT_CONTINUATION_MARKER = '<!-- delivery-v2-audit-continuation -->';
const SHA = /^[0-9a-f]{40}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/i;
const IDENTITY_KEYS = ['repository', 'issueNumber', 'pullRequestNumber', 'baseRef', 'baseSha', 'headRef', 'materialHeadSha'];
export const LEGACY_ADOPTION_AUDIT_MAX_ATTEMPTS = 1;

function positive(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function identityFor(pullRequest, { repository, issueNumber, baseBranch }) {
  if (!selectExistingPullRequest([pullRequest], { repository, issueNumber, baseBranch, trustedLogin: trustedCommentAuthorForRepository(repository) })) {
    throw new Error('legacy PR does not close the requested issue');
  }
  return {
    repository, issueNumber, pullRequestNumber: pullRequest.number, baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha.toLowerCase(), headRef: pullRequest.head.ref,
    materialHeadSha: pullRequest.head.sha.toLowerCase()
  };
}

export function createLegacyAdoption({ pullRequest, repository, issueNumber, baseBranch, bootstrapLease = null }) {
  const identity = identityFor(pullRequest, { repository, issueNumber, baseBranch });
  let implementation = null;
  let attemptEvidenceRef = null;
  if (bootstrapLease) {
    if (bootstrapLease.schemaVersion !== 1 || bootstrapLease.repository !== repository || bootstrapLease.issueNumber !== issueNumber || bootstrapLease.baseBranch !== baseBranch) {
      throw new Error('legacy adoption bootstrap identity mismatch');
    }
    if (!['reserved-initial-attempt', 'escalated-initial-budget-exhausted'].includes(bootstrapLease.status)) throw new Error('unsupported legacy bootstrap state');
    implementation = positive(bootstrapLease.implementationAttempts, 'bootstrap implementationAttempts');
    positive(bootstrapLease.controllerRunId, 'bootstrap controllerRunId');
    attemptEvidenceRef = `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${positive(bootstrapLease.commentId, 'bootstrap commentId')}`;
  }
  return {
    schemaVersion: 1, revision: 0, status: 'legacy-adopted', phase: 'identity-verified', ...identity,
    adoption: {
      source: 'github-open-pull-request', evidenceRef: `https://github.com/${repository}/pull/${pullRequest.number}`,
      author: pullRequest.user.login, authorAssociation: pullRequest.author_association,
      issueBindingSha256: createHash('sha256').update(pullRequest.body).digest('hex'),
      adoptedHeadSha: identity.materialHeadSha, adoptedBaseSha: identity.baseSha, attemptEvidenceRef
    },
    // This is a pre-operational checkpoint, NOT a fabricated operational state.
    effectiveRisk: null, classifier: null,
    attempts: { implementation, audit: null, auditRemediation: null },
    legacyAdoptionAuditAttempts: 0,
    legacyAdoptionAuditMaxAttempts: LEGACY_ADOPTION_AUDIT_MAX_ATTEMPTS,
    legacyAudit: null,
    workflowChecks: [], auditEvidence: null, continuation: null,
    blockers: ['classification-unknown', 'audit-continuation-required'], nextAction: 'collect-adoption-evidence'
  };
}

export function normalizeLegacyAdoption(value) {
  if (value?.schemaVersion !== 1 || value.status !== 'legacy-adopted') throw new Error('invalid legacy adoption checkpoint');

  // Checkpoints persisted before issue #149 do not contain the dedicated
  // post-adoption audit budget. Upgrade those records in memory without
  // inventing or modifying the historical attempts.audit/auditRemediation.
  const normalized = structuredClone(value);
  if (normalized.legacyAdoptionAuditAttempts == null) normalized.legacyAdoptionAuditAttempts = 0;
  if (normalized.legacyAdoptionAuditMaxAttempts == null) normalized.legacyAdoptionAuditMaxAttempts = LEGACY_ADOPTION_AUDIT_MAX_ATTEMPTS;
  if (normalized.legacyAudit == null) normalized.legacyAudit = null;

  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error('invalid adoption revision');
  if (!['identity-verified', 'post-write-refreeze', 'blocked'].includes(value.phase)) throw new Error('invalid adoption phase');
  if (!/^[\w.-]+\/[\w.-]+$/.test(value.repository ?? '')) throw new Error('invalid adoption repository');
  positive(value.issueNumber, 'issueNumber');
  positive(value.pullRequestNumber, 'pullRequestNumber');
  if (!value.baseRef || !value.headRef || !SHA.test(value.baseSha ?? '') || !SHA.test(value.materialHeadSha ?? '')) throw new Error('invalid adoption branch/SHA identity');
  if (value.adoption?.source !== 'github-open-pull-request' || value.adoption.evidenceRef !== `https://github.com/${value.repository}/pull/${value.pullRequestNumber}`) throw new Error('invalid adoption source');
  if (!SHA.test(value.adoption.adoptedHeadSha ?? '') || !SHA.test(value.adoption.adoptedBaseSha ?? '') || !/^[0-9a-f]{64}$/.test(value.adoption.issueBindingSha256 ?? '')) throw new Error('invalid adoption source identity');
  if (!isTrustedRepositoryAuthor({ user: { login: value.adoption.author }, author_association: value.adoption.authorAssociation }, trustedCommentAuthorForRepository(value.repository))) throw new Error('invalid adoption author provenance');
  for (const key of ['implementation', 'audit', 'auditRemediation']) {
    const count = value.attempts?.[key];
    if (count !== null && (!Number.isInteger(count) || count < 0)) throw new Error(`unknown or non-negative adoption attempts.${key} required`);
  }
  if (value.attempts.implementation !== null && !value.adoption.attemptEvidenceRef) throw new Error('adoption attempt provenance required');
  if (value.attempts.audit !== null || value.attempts.auditRemediation !== null) throw new Error('legacy adoption cannot infer historical audit counters');

  if (!Number.isInteger(normalized.legacyAdoptionAuditAttempts) || normalized.legacyAdoptionAuditAttempts < 0) {
    throw new Error('legacyAdoptionAuditAttempts must be a non-negative integer');
  }
  if (!Number.isInteger(normalized.legacyAdoptionAuditMaxAttempts) || normalized.legacyAdoptionAuditMaxAttempts < 1) {
    throw new Error('legacyAdoptionAuditMaxAttempts must be a positive integer');
  }
  if (normalized.legacyAdoptionAuditAttempts > normalized.legacyAdoptionAuditMaxAttempts) {
    throw new Error('legacy adoption audit budget exceeded');
  }

  if (normalized.legacyAudit !== null) {
    if (!normalized.legacyAudit || Array.isArray(normalized.legacyAudit) || typeof normalized.legacyAudit !== 'object') {
      throw new Error('legacyAudit must be null or an object');
    }
    if (normalized.legacyAudit.candidateSha !== value.materialHeadSha) throw new Error('legacy audit candidate is stale');
    if (!String(normalized.legacyAudit.dispatchNonce ?? '').trim()) throw new Error('legacy audit dispatch nonce required');
    if (normalized.legacyAudit.runId !== null) positive(normalized.legacyAudit.runId, 'legacy audit runId');
    if (normalized.legacyAudit.requestFingerprint !== null && !FINGERPRINT.test(normalized.legacyAudit.requestFingerprint)) {
      throw new Error('legacy audit request fingerprint invalid');
    }
    if (normalized.legacyAudit.evidenceRef !== null && !String(normalized.legacyAudit.evidenceRef).trim()) {
      throw new Error('legacy audit evidenceRef invalid');
    }
    if (![null, 'approved', 'rejected'].includes(normalized.legacyAudit.decision)) {
      throw new Error('legacy audit decision invalid');
    }
    if (!Array.isArray(normalized.legacyAudit.findings)) throw new Error('legacy audit findings must be an array');
    if (normalized.legacyAudit.decision !== null) {
      if (normalized.legacyAudit.runId === null || normalized.legacyAudit.requestFingerprint === null || normalized.legacyAudit.evidenceRef === null) {
        throw new Error('completed legacy audit requires run, fingerprint and evidence');
      }
    }
  }

  if (value.auditEvidence !== null) throw new Error('legacy continuation is not normal operational audit approval');
  if (value.classifier !== null && (!/^[0-9a-f]{64}$/.test(value.classifier?.fingerprint ?? '') || value.classifier.subjectSha !== value.materialHeadSha || value.classifier.current !== true || !value.classifier.version || !['fast', 'standard', 'critical'].includes(value.effectiveRisk))) throw new Error('invalid adoption classifier');
  if (value.classifier === null && value.effectiveRisk !== null) throw new Error('adoption risk requires classification');
  if (!Array.isArray(value.workflowChecks) || !Array.isArray(value.blockers)) throw new Error('invalid adoption evidence lists');
  for (const check of value.workflowChecks) {
    if (check.subjectSha !== value.materialHeadSha || check.status !== 'completed' || check.conclusion !== 'success' || !check.evidenceRef) throw new Error('invalid adoption CI evidence');
    positive(check.workflowRunId, 'CI workflowRunId');
  }
  if (value.phase === 'post-write-refreeze' && (!value.classifier || !value.continuation || value.workflowChecks.length === 0)) throw new Error('refreeze requires current classification, continuation and CI');
  return normalized;
}

function trustedEnvelope(comments, marker, repository, label) {
  const trustedLogin = trustedCommentAuthorForRepository(repository);
  for (const comment of comments.filter((item) => String(item.body ?? '').startsWith(marker))) {
    if (!isTrustedRepositoryAuthor(comment, trustedLogin)) throw new Error(`untrusted ${label} author`);
  }
  return parseTrustedJsonEnvelope(comments, { marker, label, trustedLogin });
}

export function parseLegacyAdoptionEnvelope(comments, repository) {
  const parsed = trustedEnvelope(comments, LEGACY_ADOPTION_MARKER, repository, 'legacy adoption');
  if (!parsed) return null;
  positive(parsed.value.controller?.controllerRunId, 'adoption controllerRunId');
  return { commentId: positive(parsed.commentId, 'adoption commentId'), adoption: normalizeLegacyAdoption(parsed.value.adoption), controller: parsed.value.controller };
}

export function validateLegacyAdoptionControllerRun(envelope, run, { orchestratorRepository, trustedRef }) {
  validateControllerRunProvenance(run, { orchestratorRepository, trustedRef });
  const controller = envelope.controller;
  if (run.id !== controller?.controllerRunId || controller.controllerRepository !== orchestratorRepository || controller.controllerRef !== trustedRef || controller.controllerWorkflowPath !== run.path) throw new Error('legacy adoption controller provenance mismatch');
  if (run.display_title !== `Delivery V2 controller ${envelope.adoption.repository} #${envelope.adoption.issueNumber}`) throw new Error('legacy adoption controller target mismatch');
}

export function parseAuditContinuation(comments, identity) {
  const parsed = trustedEnvelope(comments, AUDIT_CONTINUATION_MARKER, identity.repository, 'audit continuation');
  if (!parsed) return null;
  const value = parsed.value;
  if (value.schemaVersion !== 1) throw new Error('invalid audit continuation schemaVersion');
  // The trusted publisher requests refreeze; this never attests independent approval.
  for (const key of IDENTITY_KEYS) if (value[key] !== identity[key]) throw new Error(`audit continuation stale or mismatched ${key}`);
  if (value.reason !== 'handoff-stale' || value.recovery_scope !== 'post-write-refreeze' || value.requires_refreeze !== true || value.next_phase !== 'finalize-after-ci') throw new Error('unsupported audit continuation');
  if (typeof value.reuseExactHeadCi !== 'boolean') throw new Error('audit continuation must explicitly specify CI reuse');
  return {
    ...Object.fromEntries(IDENTITY_KEYS.map((key) => [key, value[key]])),
    reason: value.reason, recovery_scope: value.recovery_scope, requires_refreeze: true,
    next_phase: value.next_phase, reuseExactHeadCi: value.reuseExactHeadCi,
    evidenceRef: `https://github.com/${identity.repository}/pull/${identity.pullRequestNumber}#issuecomment-${positive(parsed.commentId, 'continuation commentId')}`
  };
}

export function reconcileLegacyAdoption(record, pullRequest) {
  const previous = normalizeLegacyAdoption(record);
  const observed = identityFor(pullRequest, { repository: previous.repository, issueNumber: previous.issueNumber, baseBranch: previous.baseRef });
  for (const key of ['pullRequestNumber', 'headRef']) if (observed[key] !== previous[key]) throw new Error(`adoption ${key} mismatch`);
  if (observed.materialHeadSha === previous.materialHeadSha && observed.baseSha === previous.baseSha) return previous;
  return {
    ...previous, ...observed, revision: previous.revision + 1, phase: 'blocked',
    classifier: null, effectiveRisk: null, workflowChecks: [], continuation: null,
    legacyAudit: null,
    blockers: ['adoption-identity-drift'], nextAction: 'collect-adoption-evidence'
  };
}

export function refreezeLegacyAdoption({ record, pullRequest, comments, checkoutHeadSha, plan, classifier, runs, checks, targetPolicy, controllerContinuation = null }) {
  let next = reconcileLegacyAdoption(record, pullRequest);
  if (checkoutHeadSha !== next.materialHeadSha) return { ...next, phase: 'blocked', workflowChecks: [], classifier: null, effectiveRisk: null, blockers: ['checkout-head-drift'], nextAction: 'checkout-current-pr' };
  let continuation;
  try { continuation = parseAuditContinuation(comments, next); }
  catch (error) {
    return { ...next, phase: 'blocked', workflowChecks: [], classifier: null, effectiveRisk: null, continuation: null, blockers: [error.message], nextAction: 'collect-adoption-evidence' };
  }
  if (!continuation && controllerContinuation !== null) {
    try {
      if (!controllerContinuation || Array.isArray(controllerContinuation) || typeof controllerContinuation !== 'object') {
        throw new Error('controller continuation must be an object');
      }
      for (const key of IDENTITY_KEYS) {
        if (controllerContinuation[key] !== next[key]) {
          throw new Error(`controller continuation stale or mismatched ${key}`);
        }
      }
      if (
        controllerContinuation.reason !== 'handoff-stale' ||
        controllerContinuation.recovery_scope !== 'post-write-refreeze' ||
        controllerContinuation.requires_refreeze !== true ||
        controllerContinuation.next_phase !== 'finalize-after-ci' ||
        controllerContinuation.reuseExactHeadCi !== true
      ) {
        throw new Error('unsupported controller continuation');
      }
      if (!String(controllerContinuation.evidenceRef ?? '').trim()) {
        throw new Error('controller continuation evidenceRef required');
      }
      continuation = {
        ...Object.fromEntries(IDENTITY_KEYS.map((key) => [key, controllerContinuation[key]])),
        reason: controllerContinuation.reason,
        recovery_scope: controllerContinuation.recovery_scope,
        requires_refreeze: true,
        next_phase: controllerContinuation.next_phase,
        reuseExactHeadCi: true,
        evidenceRef: String(controllerContinuation.evidenceRef).trim()
      };
    } catch (error) {
      return { ...next, phase: 'blocked', workflowChecks: [], classifier: null, effectiveRisk: null, continuation: null, blockers: [error.message], nextAction: 'collect-adoption-evidence' };
    }
  }
  if (!continuation) return { ...next, phase: 'blocked', workflowChecks: [], blockers: ['audit-continuation-required'], nextAction: 'collect-adoption-evidence' };
  if (plan?.architecture !== 'github-native-v2' || plan.repository !== next.repository || plan.issueNumber !== next.issueNumber) throw new Error('canonical adoption plan identity mismatch');
  if (plan.risk.provisional || !plan.risk.paths?.length) throw new Error('exact changed-path classification evidence required');
  if (!/^[0-9a-f]{64}$/.test(classifier?.fingerprint ?? '') || !classifier.version || classifier.subjectSha !== next.materialHeadSha) throw new Error('real exact-head classifier identity required');
  const run = selectAuthoritativeSourceWorkflowRun(runs, { workflowName: targetPolicy.ciWorkflowName, sha: next.materialHeadSha });
  const check = run ? selectCheckForWorkflowRun(checks, { requiredStatusName: targetPolicy.requiredStatusName, workflowRunId: run.id }) : null;
  const reusable = continuation.reuseExactHeadCi && run?.status === 'completed' && run.conclusion === 'success'
    && run.repository?.full_name === next.repository && run.path === targetPolicy.ciWorkflowPath && run.head_branch === next.headRef
    && check?.head_sha === next.materialHeadSha && check.app?.slug === 'github-actions'
    && Number.isInteger(run.check_suite_id) && run.check_suite_id > 0 && check.check_suite?.id === run.check_suite_id
    && check.status === 'completed' && check.conclusion === 'success';
  const auditRequired = plan.audit?.required === true;
  next = {
    ...next, revision: next.revision + 1, phase: reusable ? 'post-write-refreeze' : 'blocked',
    continuation, effectiveRisk: plan.risk.profile,
    classifier: { subjectSha: next.materialHeadSha, version: classifier.version, fingerprint: classifier.fingerprint, ...(classifier.policyFingerprint ? { policyFingerprint: classifier.policyFingerprint } : {}), current: true },
    workflowChecks: reusable ? [{ name: check.name, subjectSha: next.materialHeadSha, status: check.status, conclusion: check.conclusion, workflowRunId: run.id, evidenceRef: check.details_url }] : [],
    // Historical audit counters remain UNKNOWN. A fresh post-adoption audit uses
    // its own explicit budget and never rewrites attempts.audit/auditRemediation.
    blockers: reusable
      ? [...(auditRequired ? ['independent-audit-required'] : []), 'technical-hygiene-required']
      : ['exact-head-ci-required'],
    nextAction: reusable
      ? (auditRequired ? 'dispatch-legacy-adoption-audit' : 'collect-technical-hygiene-evidence')
      : 'observe-ci'
  };
  return normalizeLegacyAdoption(next);
}

export function reserveLegacyAdoptionAudit(record, { dispatchNonce } = {}) {
  const previous = normalizeLegacyAdoption(record);
  if (previous.phase !== 'post-write-refreeze') throw new Error('legacy audit requires post-write-refreeze');
  if (!previous.classifier?.current || previous.classifier.subjectSha !== previous.materialHeadSha) {
    throw new Error('legacy audit requires current exact-head classifier');
  }
  if (previous.workflowChecks.length === 0 || previous.workflowChecks.some((check) => check.subjectSha !== previous.materialHeadSha || check.status !== 'completed' || check.conclusion !== 'success')) {
    throw new Error('legacy audit requires exact-head terminal green CI');
  }
  if (!previous.blockers.includes('independent-audit-required')) throw new Error('legacy audit is not required for this adoption');

  const nonce = String(dispatchNonce ?? '').trim();
  if (!nonce) throw new Error('legacy audit dispatch nonce required');

  if (previous.legacyAudit !== null) {
    if (previous.legacyAudit.dispatchNonce === nonce) return previous;
    throw new Error('legacy audit already reserved with another nonce');
  }

  if (previous.legacyAdoptionAuditAttempts >= previous.legacyAdoptionAuditMaxAttempts) {
    throw new Error('legacy adoption audit budget exhausted');
  }

  return normalizeLegacyAdoption({
    ...previous,
    revision: previous.revision + 1,
    legacyAdoptionAuditAttempts: previous.legacyAdoptionAuditAttempts + 1,
    legacyAudit: {
      candidateSha: previous.materialHeadSha,
      dispatchNonce: nonce,
      runId: null,
      requestFingerprint: null,
      evidenceRef: null,
      decision: null,
      findings: []
    },
    nextAction: 'resolve-legacy-adoption-audit-run'
  });
}

export function attachLegacyAdoptionAuditRun(record, { dispatchNonce, runId } = {}) {
  const previous = normalizeLegacyAdoption(record);
  const nonce = String(dispatchNonce ?? '').trim();
  positive(runId, 'legacy audit runId');

  if (!previous.legacyAudit) throw new Error('legacy audit was not reserved');
  if (previous.legacyAudit.dispatchNonce !== nonce) throw new Error('legacy audit nonce mismatch');

  if (previous.legacyAudit.runId !== null) {
    if (previous.legacyAudit.runId === runId) return previous;
    throw new Error('legacy audit run already bound');
  }

  return normalizeLegacyAdoption({
    ...previous,
    revision: previous.revision + 1,
    legacyAudit: { ...previous.legacyAudit, runId },
    nextAction: 'observe-legacy-adoption-audit'
  });
}

export function recordLegacyAdoptionAuditResult(record, {
  runId,
  candidateSha,
  decision,
  requestFingerprint,
  evidenceRef,
  findings = []
} = {}) {
  const previous = normalizeLegacyAdoption(record);
  positive(runId, 'legacy audit runId');

  const normalizedCandidate = String(candidateSha ?? '').toLowerCase();
  const normalizedDecision = String(decision ?? '').toLowerCase();
  const normalizedFingerprint = String(requestFingerprint ?? '').toLowerCase();
  const normalizedEvidence = String(evidenceRef ?? '').trim();

  if (!previous.legacyAudit) throw new Error('legacy audit was not reserved');
  if (previous.legacyAudit.runId !== runId) throw new Error('legacy audit result run mismatch');
  if (normalizedCandidate !== previous.materialHeadSha) throw new Error('legacy audit result is stale');
  if (!['approved', 'rejected'].includes(normalizedDecision)) throw new Error('legacy audit result decision invalid');
  if (!FINGERPRINT.test(normalizedFingerprint)) throw new Error('legacy audit result fingerprint invalid');
  if (!normalizedEvidence) throw new Error('legacy audit result evidence required');
  if (!Array.isArray(findings)) throw new Error('legacy audit result findings must be an array');

  const blockers = normalizedDecision === 'approved'
    ? previous.blockers.filter((blocker) => blocker !== 'independent-audit-required')
    : [...new Set([...previous.blockers, 'independent-audit-rejected'])];

  return normalizeLegacyAdoption({
    ...previous,
    revision: previous.revision + 1,
    legacyAudit: {
      ...previous.legacyAudit,
      requestFingerprint: normalizedFingerprint,
      evidenceRef: normalizedEvidence,
      decision: normalizedDecision,
      findings: structuredClone(findings)
    },
    blockers,
    nextAction: normalizedDecision === 'approved'
      ? 'collect-technical-hygiene-evidence'
      : 'dispatch-legacy-adoption-audit-remediation'
  });
}

export function legacyAdoptionComment(record, controller) {
  return `${LEGACY_ADOPTION_MARKER}\n## Delivery V2 legacy adoption\n\n\`\`\`json\n${JSON.stringify({ adoption: normalizeLegacyAdoption(record), controller }, null, 2)}\n\`\`\``;
}
