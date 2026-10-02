const SHA_RE = /^[0-9a-f]{40}$/i;
const TERMINAL_STATUSES = new Set(['ready-for-human-merge', 'escalated', 'terminal']);
const WAIT_ACTION_PREFIXES = ['observe-', 'dispatch-'];
const RESUMABLE_ACTIONS = new Set([
  'observe-ci',
  'dispatch-ci-remediation',
  'observe-remediation',
  'dispatch-remediation',
  'dispatch-remediation-recovery',
  'observe-remediation-recovery',
  'dispatch-technical-hygiene',
  'observe-technical-hygiene',
  'dispatch-audit',
  'observe-audit'
]);

function requiredString(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function positiveInteger(value, label) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function exactSha(value, label) {
  const resolved = requiredString(value, label).toLowerCase();
  if (!SHA_RE.test(resolved)) throw new Error(`${label} must be an exact Git commit SHA`);
  return resolved;
}

export function isResumableControllerAction(action) {
  const normalized = String(action ?? '').trim();
  return RESUMABLE_ACTIONS.has(normalized) || WAIT_ACTION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function controllerWaitOwner(nextPhase) {
  const action = String(nextPhase ?? '').trim();
  if (action.includes('audit')) return 'independent-audit';
  if (action.includes('remediation')) return 'remediation';
  if (action.includes('technical-hygiene')) return 'technical-hygiene';
  if (action === 'observe-ci') return 'ci-observation';
  return 'delivery-v2-controller';
}

export function buildControllerCheckpoint({
  repository,
  issueNumber,
  pullRequestNumber,
  branch,
  materialHeadSha,
  nextPhase,
  evidenceRefs = [],
  recordedAtMs = Date.now()
} = {}) {
  const phase = requiredString(nextPhase, 'nextPhase');
  const refs = Array.isArray(evidenceRefs)
    ? evidenceRefs.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];

  return Object.freeze({
    schemaVersion: 1,
    repository: requiredString(repository, 'repository'),
    issueNumber: positiveInteger(issueNumber, 'issueNumber'),
    pullRequestNumber: positiveInteger(pullRequestNumber, 'pullRequestNumber'),
    branch: requiredString(branch, 'branch'),
    materialHeadSha: exactSha(materialHeadSha, 'materialHeadSha'),
    owner: controllerWaitOwner(phase),
    nextPhase: phase,
    freezeState: 'operational-state-persisted',
    handoffState: 'not-applicable-native-delivery-v2',
    lastEvidenceRef: refs.at(-1) ?? null,
    recordedAt: new Date(recordedAtMs).toISOString()
  });
}

export function checkpointElapsedMs(checkpoint, nowMs = Date.now()) {
  const recordedAt = Date.parse(String(checkpoint?.recordedAt ?? ''));
  if (!Number.isFinite(recordedAt)) throw new Error('checkpoint.recordedAt must be a valid timestamp');
  return Math.max(0, Number(nowMs) - recordedAt);
}

export function continuationFingerprint(checkpoint) {
  return [
    requiredString(checkpoint?.repository, 'checkpoint.repository'),
    positiveInteger(checkpoint?.issueNumber, 'checkpoint.issueNumber'),
    positiveInteger(checkpoint?.pullRequestNumber, 'checkpoint.pullRequestNumber'),
    exactSha(checkpoint?.materialHeadSha, 'checkpoint.materialHeadSha'),
    requiredString(checkpoint?.nextPhase, 'checkpoint.nextPhase')
  ].join(':');
}

export function decideControllerContinuation({
  controllerOutcome,
  stateStatus,
  nextAction,
  checkpoint,
  previousContinuationCount = 0,
  maxContinuations = 3
} = {}) {
  const outcome = String(controllerOutcome ?? '').trim().toLowerCase();
  const status = String(stateStatus ?? '').trim();
  const phase = String(nextAction ?? checkpoint?.nextPhase ?? '').trim();
  const count = Number(previousContinuationCount);
  const budget = Number(maxContinuations);

  if (outcome !== 'failure') return Object.freeze({ action: 'none', reason: 'controller-not-failed' });
  if (TERMINAL_STATUSES.has(status)) return Object.freeze({ action: 'none', reason: 'state-terminal' });
  if (!checkpoint) return Object.freeze({ action: 'none', reason: 'checkpoint-missing' });
  if (String(checkpoint.nextPhase ?? '').trim() !== phase) {
    return Object.freeze({ action: 'blocked', reason: 'checkpoint-phase-mismatch' });
  }
  if (!isResumableControllerAction(phase)) return Object.freeze({ action: 'none', reason: 'phase-not-resumable' });
  if (!Number.isInteger(count) || count < 0) throw new Error('previousContinuationCount must be a non-negative integer');
  if (!Number.isInteger(budget) || budget < 1) throw new Error('maxContinuations must be a positive integer');
  if (count >= budget) return Object.freeze({ action: 'blocked', reason: 'continuation-budget-exhausted' });

  return Object.freeze({
    action: 'dispatch-resume',
    reason: 'interrupted-controller-with-recoverable-checkpoint',
    nextPhase: phase,
    nextContinuationCount: count + 1,
    fingerprint: continuationFingerprint(checkpoint)
  });
}

export function originIssueStatus({ result, controllerOutcome, continuationScheduled = false, runUrl = null } = {}) {
  const status = String(result?.status ?? '').trim();
  const head = String(result?.materialHeadSha ?? '').trim().toLowerCase();
  const pr = Number(result?.pullRequestNumber);
  const evidence = runUrl ? `\n\nExecução: ${runUrl}` : '';

  if (continuationScheduled) {
    return Object.freeze({
      terminal: false,
      state: 'retomada-agendada',
      body: `A execução foi interrompida após checkpoint persistido e a retomada automática foi agendada.${evidence}`
    });
  }
  if (status === 'ready-for-human-merge') {
    return Object.freeze({
      terminal: true,
      state: 'concluida',
      body: `Entrega concluída até o gate de release${Number.isInteger(pr) ? ` na PR #${pr}` : ''}${SHA_RE.test(head) ? `, head \`${head}\`` : ''}.${evidence}`
    });
  }
  if (status === 'escalated' || status === 'terminal') {
    return Object.freeze({
      terminal: true,
      state: status,
      body: `Entrega encerrada em estado \`${status}\`${Number.isInteger(pr) ? ` na PR #${pr}` : ''}${SHA_RE.test(head) ? `, head \`${head}\`` : ''}.${evidence}`
    });
  }
  if (String(controllerOutcome ?? '').trim().toLowerCase() === 'failure') {
    return Object.freeze({
      terminal: true,
      state: 'interrompida-sem-retomada',
      body: `A execução falhou sem checkpoint retomável ou esgotou o orçamento de retomadas.${evidence}`
    });
  }
  return Object.freeze({ terminal: false, state: 'em-andamento', body: `Entrega ainda em andamento.${evidence}` });
}
