import { STATES } from './constants.mjs';

const ALLOWED = new Map([
  [STATES.NEW, new Set([STATES.IMPLEMENTING, STATES.FAILED])],
  [STATES.IMPLEMENTING, new Set([STATES.HANDOFF_READY, STATES.BLOCKED_REQUIREMENT, STATES.BLOCKED_EXTERNAL, STATES.FAILED])],
  [STATES.REMEDIATING, new Set([STATES.HANDOFF_READY, STATES.BLOCKED_REQUIREMENT, STATES.BLOCKED_EXTERNAL, STATES.FAILED])],
  [STATES.HANDOFF_READY, new Set([STATES.AUDITING, STATES.BLOCKED_EXTERNAL, STATES.FAILED])],
  [STATES.AUDITING, new Set([STATES.COMPLETE, STATES.REMEDIATING, STATES.BLOCKED_EXTERNAL, STATES.NO_PROGRESS, STATES.FAILED])]
]);

export function transition(state, next, detail = {}) {
  const allowed = ALLOWED.get(state.status);
  if (!allowed?.has(next)) {
    throw new Error(`Invalid orchestrator transition ${state.status} -> ${next}`);
  }
  return {
    ...state,
    status: next,
    updated_at: new Date().toISOString(),
    history: [...state.history, { from: state.status, to: next, at: new Date().toISOString(), ...detail }]
  };
}

export function initialState({ runId, repository, issueNumber, maxCycles }) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: runId,
    repository,
    issue_number: issueNumber,
    status: STATES.NEW,
    cycle: 0,
    max_cycles: maxCycles,
    material_head_sha: null,
    handoff_head_sha: null,
    implementation_context_ids: [],
    audit_context_ids: [],
    audit_fingerprints: [],
    last_audit: null,
    created_at: now,
    updated_at: now,
    history: []
  };
}
