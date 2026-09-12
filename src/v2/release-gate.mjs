import { executionPolicyFor } from './execution-policy.mjs';

export const DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION = 1;
export const DELIVERY_V2_RELEASE_STATUS_NAME = 'Delivery V2 Release';

const SHA_RE = /^[0-9a-f]{40}$/i;
const CHECK_TERMINAL = new Set(['completed']);
const CHECK_GREEN = new Set(['success']);
const BLOCKER_KINDS = new Set(['budget', 'external']);
const AUDIT_DECISIONS = new Set(['approved', 'rejected', 'not-required']);

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function requireSha(value, label) {
  const sha = requireString(value, label).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return sha;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function normalizeRepository(value) {
  const repository = requireString(value, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository must use owner/name form');
  return repository;
}

function normalizeCheck(check, index) {
  const value = requireObject(check, `checks[${index}]`);
  const status = requireString(value.status, `checks[${index}].status`).toLowerCase();
  const conclusion = value.conclusion == null ? null : requireString(value.conclusion, `checks[${index}].conclusion`).toLowerCase();
  return Object.freeze({
    name: requireString(value.name, `checks[${index}].name`),
    required: value.required !== false,
    subjectSha: requireSha(value.subjectSha, `checks[${index}].subjectSha`),
    status,
    conclusion,
    workflowRunId: value.workflowRunId == null ? null : requirePositiveInteger(value.workflowRunId, `checks[${index}].workflowRunId`),
    evidenceRef: requireString(value.evidenceRef, `checks[${index}].evidenceRef`)
  });
}

function normalizeFinding(finding, index) {
  const value = requireObject(finding, `unresolvedFindings[${index}]`);
  return Object.freeze({
    id: requireString(value.id, `unresolvedFindings[${index}].id`),
    candidateSha: requireSha(value.candidateSha, `unresolvedFindings[${index}].candidateSha`),
    status: requireString(value.status, `unresolvedFindings[${index}].status`).toLowerCase(),
    blocksRelease: value.blocksRelease === true,
    evidenceRef: requireString(value.evidenceRef, `unresolvedFindings[${index}].evidenceRef`)
  });
}

function normalizeBlocker(blocker, index) {
  const value = requireObject(blocker, `blockers[${index}]`);
  const kind = requireString(value.kind, `blockers[${index}].kind`).toLowerCase();
  if (!BLOCKER_KINDS.has(kind)) throw new Error(`blockers[${index}].kind must be budget or external`);
  return Object.freeze({
    kind,
    code: requireString(value.code, `blockers[${index}].code`),
    evidenceRef: requireString(value.evidenceRef, `blockers[${index}].evidenceRef`)
  });
}

function normalizeAudit(audit) {
  if (audit == null) return null;
  const value = requireObject(audit, 'audit');
  const decision = requireString(value.decision, 'audit.decision').toLowerCase();
  if (!AUDIT_DECISIONS.has(decision)) throw new Error('audit.decision must be approved, rejected, or not-required');
  return Object.freeze({
    candidateSha: requireSha(value.candidateSha, 'audit.candidateSha'),
    decision,
    mode: requireString(value.mode, 'audit.mode').toLowerCase(),
    requestFingerprint: requireString(value.requestFingerprint, 'audit.requestFingerprint'),
    evidenceRef: requireString(value.evidenceRef, 'audit.evidenceRef')
  });
}

function auditPolicyFor(profile, standardAuditRequired) {
  const policy = executionPolicyFor(profile);
  if (profile === 'fast') return Object.freeze({ required: false, mode: 'none' });
  if (profile === 'standard' && standardAuditRequired === false) {
    return Object.freeze({ required: false, mode: 'none' });
  }
  return Object.freeze({ required: true, mode: policy.auditMode });
}

export function normalizeReleaseGateInput(input) {
  const value = requireObject(input, 'release gate input');
  if (value.schemaVersion !== DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION) {
    throw new Error(`release gate schemaVersion must be ${DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION}`);
  }

  const materialHeadSha = requireSha(value.materialHeadSha, 'materialHeadSha');
  const currentRemoteHeadSha = requireSha(value.currentRemoteHeadSha, 'currentRemoteHeadSha');
  const evidenceCollection = requireObject(value.evidenceCollection, 'evidenceCollection');
  const classifier = requireObject(value.classifier, 'classifier');
  const profile = requireString(classifier.profile, 'classifier.profile').toLowerCase();
  executionPolicyFor(profile);

  const checks = value.checks;
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('checks must be a non-empty array');
  const normalizedChecks = checks.map(normalizeCheck);
  if (!normalizedChecks.some((check) => check.required)) throw new Error('at least one required CI check is required');

  const mergePreview = value.mergePreview == null
    ? Object.freeze({ required: false, materialHeadSha: null, previewSha: null, status: null, conclusion: null, evidenceRef: null })
    : (() => {
        const preview = requireObject(value.mergePreview, 'mergePreview');
        const required = preview.required === true;
        return Object.freeze({
          required,
          materialHeadSha: preview.materialHeadSha == null ? null : requireSha(preview.materialHeadSha, 'mergePreview.materialHeadSha'),
          previewSha: preview.previewSha == null ? null : requireSha(preview.previewSha, 'mergePreview.previewSha'),
          status: preview.status == null ? null : requireString(preview.status, 'mergePreview.status').toLowerCase(),
          conclusion: preview.conclusion == null ? null : requireString(preview.conclusion, 'mergePreview.conclusion').toLowerCase(),
          evidenceRef: preview.evidenceRef == null ? null : requireString(preview.evidenceRef, 'mergePreview.evidenceRef')
        });
      })();

  return Object.freeze({
    schemaVersion: DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION,
    repository: normalizeRepository(value.repository),
    pullRequestNumber: requirePositiveInteger(value.pullRequestNumber, 'pullRequestNumber'),
    materialHeadSha,
    currentRemoteHeadSha,
    evidenceCollection: Object.freeze({
      materialHeadSha: requireSha(evidenceCollection.materialHeadSha, 'evidenceCollection.materialHeadSha'),
      remoteHeadSha: requireSha(evidenceCollection.remoteHeadSha, 'evidenceCollection.remoteHeadSha'),
      evidenceRef: requireString(evidenceCollection.evidenceRef, 'evidenceCollection.evidenceRef')
    }),
    classifier: Object.freeze({
      subjectSha: requireSha(classifier.subjectSha, 'classifier.subjectSha'),
      profile,
      version: requireString(classifier.version, 'classifier.version'),
      fingerprint: requireString(classifier.fingerprint, 'classifier.fingerprint'),
      expectedFingerprint: requireString(classifier.expectedFingerprint, 'classifier.expectedFingerprint'),
      evidenceRef: requireString(classifier.evidenceRef, 'classifier.evidenceRef')
    }),
    mergePreview,
    checks: Object.freeze(normalizedChecks),
    standardAuditRequired: value.standardAuditRequired !== false,
    audit: normalizeAudit(value.audit),
    unresolvedFindings: Object.freeze((value.unresolvedFindings ?? []).map(normalizeFinding)),
    blockers: Object.freeze((value.blockers ?? []).map(normalizeBlocker))
  });
}

function requiredStatus(state) {
  if (state === 'ready-for-human-merge') return Object.freeze({ name: DELIVERY_V2_RELEASE_STATUS_NAME, state: 'success' });
  if (['ci-failed-remediable', 'audit-failed-remediable', 'escalated'].includes(state)) {
    return Object.freeze({ name: DELIVERY_V2_RELEASE_STATUS_NAME, state: 'failure' });
  }
  return Object.freeze({ name: DELIVERY_V2_RELEASE_STATUS_NAME, state: 'pending' });
}

function result(input, { state, reasons = [], evidenceRefs = {} }) {
  const readiness = state === 'ready-for-human-merge';
  return Object.freeze({
    schemaVersion: DELIVERY_V2_RELEASE_GATE_SCHEMA_VERSION,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    candidateSha: input.materialHeadSha,
    currentRemoteHeadSha: input.currentRemoteHeadSha,
    readiness,
    state,
    reasons: Object.freeze(reasons),
    requiredStatus: requiredStatus(state),
    mergePolicy: Object.freeze({ decision: 'human-authorized-only', automaticMergeAllowed: false }),
    evidenceRefs: Object.freeze(evidenceRefs),
    controls: Object.freeze({ storesEvidenceReferencesOnly: true, createsResultOnlyCommit: false })
  });
}

export function evaluateReleaseGate(rawInput) {
  const input = normalizeReleaseGateInput(rawInput);
  const evidenceRefs = {
    collection: input.evidenceCollection.evidenceRef,
    classifier: input.classifier.evidenceRef,
    mergePreview: input.mergePreview.evidenceRef,
    checks: input.checks.map((check) => check.evidenceRef),
    audit: input.audit?.evidenceRef ?? null,
    findings: input.unresolvedFindings.map((finding) => finding.evidenceRef),
    blockers: input.blockers.map((blocker) => blocker.evidenceRef)
  };

  if (input.currentRemoteHeadSha !== input.materialHeadSha) {
    return result(input, { state: 'queued', reasons: ['remote-head-drift'], evidenceRefs });
  }
  if (input.evidenceCollection.materialHeadSha !== input.materialHeadSha || input.evidenceCollection.remoteHeadSha !== input.materialHeadSha) {
    return result(input, { state: 'queued', reasons: ['evidence-collected-for-different-head'], evidenceRefs });
  }
  if (input.classifier.subjectSha !== input.materialHeadSha) {
    return result(input, { state: 'classified', reasons: ['classifier-subject-sha-stale'], evidenceRefs });
  }
  if (input.classifier.fingerprint !== input.classifier.expectedFingerprint) {
    return result(input, { state: 'classified', reasons: ['classifier-fingerprint-mismatch'], evidenceRefs });
  }

  if (input.mergePreview.required) {
    if (!input.mergePreview.materialHeadSha || input.mergePreview.materialHeadSha !== input.materialHeadSha) {
      return result(input, { state: 'ci-pending', reasons: ['merge-preview-stale-or-unbound'], evidenceRefs });
    }
    if (!input.mergePreview.previewSha || !input.mergePreview.evidenceRef) {
      return result(input, { state: 'ci-pending', reasons: ['merge-preview-missing'], evidenceRefs });
    }
    if (!CHECK_TERMINAL.has(input.mergePreview.status)) {
      return result(input, { state: 'ci-pending', reasons: ['merge-preview-pending'], evidenceRefs });
    }
    if (!CHECK_GREEN.has(input.mergePreview.conclusion)) {
      return result(input, { state: 'ci-failed-remediable', reasons: ['merge-preview-not-green'], evidenceRefs });
    }
  }

  const requiredChecks = input.checks.filter((check) => check.required);
  const staleCheck = requiredChecks.find((check) => check.subjectSha !== input.materialHeadSha);
  if (staleCheck) {
    return result(input, { state: 'ci-pending', reasons: [`required-check-stale:${staleCheck.name}`], evidenceRefs });
  }
  const pendingCheck = requiredChecks.find((check) => !CHECK_TERMINAL.has(check.status));
  if (pendingCheck) {
    return result(input, { state: 'ci-pending', reasons: [`required-check-pending:${pendingCheck.name}`], evidenceRefs });
  }
  const failedCheck = requiredChecks.find((check) => !CHECK_GREEN.has(check.conclusion));
  if (failedCheck) {
    return result(input, { state: 'ci-failed-remediable', reasons: [`required-check-not-green:${failedCheck.name}`], evidenceRefs });
  }

  const budgetBlocker = input.blockers.find((blocker) => blocker.kind === 'budget');
  if (budgetBlocker) {
    return result(input, { state: 'escalated', reasons: [`budget-blocker:${budgetBlocker.code}`], evidenceRefs });
  }
  const externalBlocker = input.blockers.find((blocker) => blocker.kind === 'external');
  if (externalBlocker) {
    return result(input, { state: 'ci-pending', reasons: [`external-blocker:${externalBlocker.code}`], evidenceRefs });
  }

  const blockingFinding = input.unresolvedFindings.find((finding) => finding.blocksRelease && finding.status !== 'resolved');
  if (blockingFinding) {
    if (blockingFinding.candidateSha !== input.materialHeadSha) {
      return result(input, { state: 'audit-pending', reasons: [`blocking-finding-stale:${blockingFinding.id}`], evidenceRefs });
    }
    return result(input, { state: 'audit-failed-remediable', reasons: [`blocking-finding:${blockingFinding.id}`], evidenceRefs });
  }

  const auditPolicy = auditPolicyFor(input.classifier.profile, input.standardAuditRequired);
  if (auditPolicy.required) {
    if (!input.audit) return result(input, { state: 'audit-pending', reasons: ['required-audit-missing'], evidenceRefs });
    if (input.audit.candidateSha !== input.materialHeadSha) {
      return result(input, { state: 'audit-pending', reasons: ['required-audit-stale'], evidenceRefs });
    }
    if (input.audit.mode !== auditPolicy.mode) {
      return result(input, { state: 'audit-pending', reasons: ['required-audit-mode-mismatch'], evidenceRefs });
    }
    if (input.audit.decision === 'rejected') {
      return result(input, { state: 'audit-failed-remediable', reasons: ['required-audit-rejected'], evidenceRefs });
    }
    if (input.audit.decision !== 'approved') {
      return result(input, { state: 'audit-pending', reasons: ['required-audit-not-approved'], evidenceRefs });
    }
  } else if (input.audit) {
    if (input.audit.candidateSha !== input.materialHeadSha) {
      return result(input, { state: 'audit-pending', reasons: ['optional-audit-stale'], evidenceRefs });
    }
    if (input.audit.decision === 'rejected') {
      return result(input, { state: 'audit-failed-remediable', reasons: ['optional-audit-rejected'], evidenceRefs });
    }
  }

  return result(input, { state: 'ready-for-human-merge', evidenceRefs });
}
