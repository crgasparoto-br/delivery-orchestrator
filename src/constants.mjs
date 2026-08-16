export const STATES = Object.freeze({
  NEW: 'NEW',
  IMPLEMENTING: 'IMPLEMENTING',
  HANDOFF_READY: 'HANDOFF_READY',
  AUDITING: 'AUDITING',
  REMEDIATING: 'REMEDIATING',
  COMPLETE: 'COMPLETE',
  BLOCKED_EXTERNAL: 'BLOCKED_EXTERNAL',
  BLOCKED_REQUIREMENT: 'BLOCKED_REQUIREMENT',
  NO_PROGRESS: 'NO_PROGRESS',
  FAILED: 'FAILED'
});

export const TERMINAL_STATES = new Set([
  STATES.COMPLETE,
  STATES.BLOCKED_EXTERNAL,
  STATES.BLOCKED_REQUIREMENT,
  STATES.NO_PROGRESS,
  STATES.FAILED
]);

export const IMPLEMENTER_SKILLS = Object.freeze([
  'entregar-issue',
  'revisar-issue',
  'fluxos-conversacionais',
  'documentacao-repositorio',
  'design-interface',
  'corrigir-ci'
]);

export const AUDITOR_SKILLS = Object.freeze([
  'auditar-issue',
  'fluxos-conversacionais',
  'documentacao-repositorio',
  'design-interface'
]);
