export const IMPLEMENTER_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ready_for_audit', 'blocked_requirement', 'blocked_external', 'failed'] },
    material_head_sha: { type: ['string', 'null'] },
    handoff_head_sha: { type: ['string', 'null'] },
    summary: { type: 'string' },
    blocking_reason: { type: ['string', 'null'] },
    changed_files: { type: 'array', items: { type: 'string' } }
  },
  required: ['status', 'material_head_sha', 'handoff_head_sha', 'summary', 'blocking_reason', 'changed_files']
};

export const AUDIT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['approved', 'approved_with_reservations', 'rejected', 'inconclusive'] },
    validity: { type: 'string', enum: ['independent', 'pre-audit', 'controller-adversarial'] },
    release_gate_satisfied: { type: 'boolean' },
    material_head_sha: { type: ['string', 'null'] },
    handoff_head_sha: { type: ['string', 'null'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          requirement: { type: 'string' },
          cause: { type: 'string' },
          remediation: { type: 'string' },
          fingerprint: { type: 'string' }
        },
        required: ['id', 'severity', 'requirement', 'cause', 'remediation', 'fingerprint']
      }
    },
    limitations: { type: 'array', items: { type: 'string' } }
  },
  required: ['status', 'validity', 'release_gate_satisfied', 'material_head_sha', 'handoff_head_sha', 'summary', 'findings', 'limitations']
};
