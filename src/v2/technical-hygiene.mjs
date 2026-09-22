export const DELIVERY_V2_TECHNICAL_HYGIENE_SCHEMA_VERSION = 1;

export const TECHNICAL_HYGIENE_RESULTS = Object.freeze(['PASS', 'PASS_WITH_DEBT', 'BLOCK', 'UNKNOWN']);
export const REUSE_DECISIONS = Object.freeze([
  'REUSE_EXISTING',
  'EXTEND_EXISTING',
  'LOCAL_REFACTOR',
  'CREATE_NEW',
  'KEEP_SEPARATE',
  'UNKNOWN'
]);

const SHA_RE = /^[0-9a-f]{40}$/i;
const PROFILES = new Set(['fast', 'standard', 'critical']);
const RESULTS = new Set(TECHNICAL_HYGIENE_RESULTS);
const DECISIONS = new Set(REUSE_DECISIONS);
const STRUCTURAL_FINDING_KINDS = new Set([
  'file-growth',
  'fallback',
  'workaround',
  'duplication',
  'parallel-abstraction',
  'dead-code',
  'responsibility-growth',
  'avoidable-complexity',
  'created-files',
  'textual-similarity'
]);
const STRUCTURAL_BOOLEAN_FIELDS = Object.freeze([
  'material',
  'preexisting',
  'newResponsibilities',
  'complexityIncreased',
  'cohesive'
]);
const LOCAL_POLICY_KEYS = new Set(['thresholds', 'tools', 'severityPromotions']);

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function sha(value, label) {
  const resolved = string(value, label).toLowerCase();
  if (!SHA_RE.test(resolved)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return resolved;
}

function evidence(value, label, { required = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const refs = [...new Set(value.map((item) => string(item, `${label} entry`)))];
  if (required && refs.length === 0) throw new Error(`${label} requires at least one evidence reference`);
  return Object.freeze(refs);
}

function normalizeLocalPolicy(value) {
  if (value == null) return Object.freeze({ thresholds: Object.freeze({}), tools: Object.freeze([]), severityPromotions: Object.freeze([]) });
  const policy = object(value, 'localPolicy');
  for (const key of Object.keys(policy)) {
    if (!LOCAL_POLICY_KEYS.has(key)) throw new Error(`localPolicy cannot override central hygiene invariant: ${key}`);
  }
  const thresholds = policy.thresholds == null ? {} : object(policy.thresholds, 'localPolicy.thresholds');
  for (const [key, threshold] of Object.entries(thresholds)) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) throw new Error(`localPolicy.thresholds.${key} must be non-negative`);
  }
  return Object.freeze({
    thresholds: Object.freeze({ ...thresholds }),
    tools: evidence(policy.tools ?? [], 'localPolicy.tools'),
    severityPromotions: evidence(policy.severityPromotions ?? [], 'localPolicy.severityPromotions')
  });
}

function normalizeReuse(entry, index) {
  const value = object(entry, `reuseDiscovery[${index}]`);
  const decision = string(value.decision, `reuseDiscovery[${index}].decision`).toUpperCase();
  if (!DECISIONS.has(decision)) throw new Error(`unsupported reuse decision: ${decision}`);
  return Object.freeze({
    symbol: string(value.symbol, `reuseDiscovery[${index}].symbol`),
    decision,
    material: value.material !== false,
    evidence: evidence(value.evidence ?? [], `reuseDiscovery[${index}].evidence`),
    existingOwnerEvidence: evidence(value.existingOwnerEvidence ?? [], `reuseDiscovery[${index}].existingOwnerEvidence`),
    justificationEvidence: evidence(value.justificationEvidence ?? [], `reuseDiscovery[${index}].justificationEvidence`)
  });
}

function normalizeFinding(entry, index, label = 'structuralFindings') {
  const value = object(entry, `${label}[${index}]`);
  const kind = string(value.kind, `${label}[${index}].kind`).toLowerCase();

  const malformedFields = [];

  for (const field of STRUCTURAL_BOOLEAN_FIELDS) {
    if (
      value[field] != null &&
      typeof value[field] !== 'boolean'
    ) {
      malformedFields.push(field);
    }
  }

  let ordinal = 1;

  if (value.ordinal != null) {
    ordinal = Number(value.ordinal);

    if (!Number.isInteger(ordinal) || ordinal < 1) {
      malformedFields.push('ordinal');
    }
  }

  return Object.freeze({
    kind,
    supportedKind: STRUCTURAL_FINDING_KINDS.has(kind),
    malformedFields: Object.freeze([...new Set(malformedFields)]),
    material: value.material !== false,
    preexisting: value.preexisting === true,
    evidence: evidence(value.evidence ?? [], `${label}[${index}].evidence`),
    rootCauseEvidence: evidence(
      value.rootCauseEvidence ?? [],
      `${label}[${index}].rootCauseEvidence`
    ),
    ordinal,
    newResponsibilities: value.newResponsibilities === true,
    complexityIncreased: value.complexityIncreased === true,
    cohesive: value.cohesive !== false
  });
}

function normalizeSemantic(entry, index) {
  const value = object(entry, `semanticJudgments[${index}]`);
  return Object.freeze({
    claim: string(value.claim, `semanticJudgments[${index}].claim`),
    claimKind: string(value.claimKind ?? 'architectural', `semanticJudgments[${index}].claimKind`).toLowerCase(),
    decision: string(value.decision, `semanticJudgments[${index}].decision`).toUpperCase(),
    material: value.material !== false,
    confidence: value.confidence == null ? null : string(value.confidence, `semanticJudgments[${index}].confidence`).toLowerCase(),
    evidence: evidence(value.evidence ?? [], `semanticJudgments[${index}].evidence`)
  });
}

function normalizeReference(entry, index) {
  const value = object(entry, `deterministicReferences[${index}]`);
  return Object.freeze({
    symbol: string(value.symbol, `deterministicReferences[${index}].symbol`),
    referenced: value.referenced === true,
    evidence: evidence(value.evidence ?? [], `deterministicReferences[${index}].evidence`, { required: true })
  });
}

function missing(code, detail, material = true) {
  return Object.freeze({ code, detail, material });
}

export function evaluateTechnicalHygiene(rawInput) {
  const input = object(rawInput, 'technical hygiene input');
  if (input.schemaVersion !== DELIVERY_V2_TECHNICAL_HYGIENE_SCHEMA_VERSION) throw new Error('technical hygiene schemaVersion must be 1');
  const profile = string(input.profile, 'profile').toLowerCase();
  if (!PROFILES.has(profile)) throw new Error('profile must be fast, standard, or critical');
  const baselineSha = sha(input.baselineSha, 'baselineSha');
  const materialSha = sha(input.materialSha, 'materialSha');
  const previousMaterialSha = input.previousMaterialSha == null ? null : sha(input.previousMaterialSha, 'previousMaterialSha');
  const createdFiles = evidence(input.createdFiles ?? [], 'createdFiles');
  normalizeLocalPolicy(input.localPolicy);

  const reuseDiscovery = (input.reuseDiscovery ?? []).map(normalizeReuse);
  const structuralFindings = (input.structuralFindings ?? []).map((entry, index) => normalizeFinding(entry, index));
  const semanticJudgments = (input.semanticJudgments ?? []).map(normalizeSemantic);
  const deterministicReferences = (input.deterministicReferences ?? []).map(normalizeReference);
  const suppliedMissingEvidence = (input.missingEvidence ?? []).map((entry, index) => {
    const value = object(entry, `missingEvidence[${index}]`);
    return missing(string(value.code, `missingEvidence[${index}].code`), string(value.detail, `missingEvidence[${index}].detail`), value.material !== false);
  });

  const findings = [];
  const missingEvidence = [...suppliedMissingEvidence];
  const overriddenSemanticClaims = [];

  for (const reuse of reuseDiscovery) {
    if (reuse.material && reuse.decision === 'UNKNOWN') missingEvidence.push(missing('reuse-owner-unknown', reuse.symbol));
    if (reuse.material && reuse.evidence.length === 0) missingEvidence.push(missing('reuse-decision-without-evidence', reuse.symbol));
    if (reuse.decision === 'CREATE_NEW' && reuse.existingOwnerEvidence.length > 0 && reuse.justificationEvidence.length === 0) {
      findings.push(Object.freeze({ kind: 'parallel-abstraction-with-known-owner', material: true, evidence: reuse.existingOwnerEvidence }));
    }
  }

  for (const finding of structuralFindings) {
    if (!finding.material) continue;

    if (!finding.supportedKind) {
      missingEvidence.push(
        missing(
          'structural-unknown-kind',
          `unsupported structural finding kind: ${finding.kind}`
        )
      );
      continue;
    }

    if (finding.malformedFields.length > 0) {
      missingEvidence.push(
        missing(
          'structural-malformed-fields',
          `${finding.kind}: ${finding.malformedFields.join(', ')}`
        )
      );
      continue;
    }

    if (finding.evidence.length === 0) {
      missingEvidence.push(missing(`structural-${finding.kind}-without-evidence`, finding.kind));
      continue;
    }
    if (finding.preexisting) continue;
    if (finding.kind === 'file-growth') {
      if (finding.newResponsibilities && finding.complexityIncreased) findings.push(finding);
      continue;
    }
    if (finding.kind === 'fallback' || finding.kind === 'workaround') {
      if (finding.ordinal >= 2 && finding.rootCauseEvidence.length === 0) findings.push(finding);
      continue;
    }
    if (['duplication', 'parallel-abstraction', 'dead-code', 'responsibility-growth', 'avoidable-complexity'].includes(finding.kind)) findings.push(finding);
  }

  for (const judgment of semanticJudgments) {
    const deterministicRef = judgment.claimKind === 'dead-code'
      ? deterministicReferences.find((ref) => ref.symbol === judgment.claim && ref.referenced)
      : null;
    if (deterministicRef) {
      overriddenSemanticClaims.push(Object.freeze({ claim: judgment.claim, reason: 'deterministic-reference-proves-use', evidence: deterministicRef.evidence }));
      continue;
    }
    if (judgment.material && judgment.evidence.length === 0) missingEvidence.push(missing('semantic-claim-without-evidence', judgment.claim));
  }

  const materialMissing = missingEvidence.filter((entry) => entry.material);
  const preexistingDebt = structuralFindings.some((finding) => finding.preexisting && finding.evidence.length > 0);
  let result = 'PASS';
  if (findings.length > 0) result = 'BLOCK';
  else if (materialMissing.length > 0) result = 'UNKNOWN';
  else if (preexistingDebt) result = 'PASS_WITH_DEBT';

  const promotionRequired = result === 'UNKNOWN' && profile === 'fast';
  const effectiveProfile = promotionRequired ? 'standard' : profile;

  return Object.freeze({
    schemaVersion: DELIVERY_V2_TECHNICAL_HYGIENE_SCHEMA_VERSION,
    baselineSha,
    materialSha,
    previousMaterialSha,
    result,
    effectiveProfile,
    promotionRequired,
    releaseAllowed: result === 'PASS' || result === 'PASS_WITH_DEBT',
    reusedSymbols: Object.freeze(reuseDiscovery.filter((entry) => entry.decision === 'REUSE_EXISTING').map((entry) => entry.symbol)),
    extendedSymbols: Object.freeze(reuseDiscovery.filter((entry) => entry.decision === 'EXTEND_EXISTING').map((entry) => entry.symbol)),
    createdSymbols: Object.freeze(reuseDiscovery.filter((entry) => entry.decision === 'CREATE_NEW').map((entry) => entry.symbol)),
    createdFiles,
    structuralFindings: Object.freeze(findings),
    missingEvidence: Object.freeze(missingEvidence),
    overriddenSemanticClaims: Object.freeze(overriddenSemanticClaims),
    semanticCalls: Number.isInteger(input.semanticCalls) && input.semanticCalls >= 0 ? input.semanticCalls : 0,
    evidenceRef: string(input.evidenceRef, 'evidenceRef')
  });
}

export function normalizeTechnicalHygieneResult(rawResult) {
  const value = object(rawResult, 'technical hygiene result');
  if (value.schemaVersion !== DELIVERY_V2_TECHNICAL_HYGIENE_SCHEMA_VERSION) throw new Error('technical hygiene result schemaVersion must be 1');
  const result = string(value.result, 'technical hygiene result.result').toUpperCase();
  if (!RESULTS.has(result)) throw new Error(`unsupported technical hygiene result: ${result}`);
  const effectiveProfile = string(value.effectiveProfile, 'technical hygiene result.effectiveProfile').toLowerCase();
  if (!PROFILES.has(effectiveProfile)) throw new Error('technical hygiene result.effectiveProfile must be fast, standard, or critical');
  return Object.freeze({
    schemaVersion: 1,
    materialSha: sha(value.materialSha, 'technical hygiene result.materialSha'),
    baselineSha: sha(value.baselineSha, 'technical hygiene result.baselineSha'),
    previousMaterialSha: value.previousMaterialSha == null ? null : sha(value.previousMaterialSha, 'technical hygiene result.previousMaterialSha'),
    result,
    effectiveProfile,
    promotionRequired: value.promotionRequired === true,
    reusedSymbols: evidence(value.reusedSymbols ?? [], 'technical hygiene result.reusedSymbols'),
    extendedSymbols: evidence(value.extendedSymbols ?? [], 'technical hygiene result.extendedSymbols'),
    createdSymbols: evidence(value.createdSymbols ?? [], 'technical hygiene result.createdSymbols'),
    createdFiles: evidence(value.createdFiles ?? [], 'technical hygiene result.createdFiles'),
    structuralFindings: Object.freeze((value.structuralFindings ?? []).map((entry, index) => normalizeFinding(entry, index, 'technical hygiene result.structuralFindings'))),
    missingEvidence: Object.freeze((value.missingEvidence ?? []).map((entry, index) => {
      const item = object(entry, `technical hygiene result.missingEvidence[${index}]`);
      return missing(string(item.code, `technical hygiene result.missingEvidence[${index}].code`), string(item.detail, `technical hygiene result.missingEvidence[${index}].detail`), item.material !== false);
    })),
    evidenceRef: string(value.evidenceRef, 'technical hygiene result.evidenceRef')
  });
}
