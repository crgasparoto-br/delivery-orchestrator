import { appendFile } from 'node:fs/promises';

// Operator-facing GitHub Actions Job Summary for the Delivery V2 controller.
//
// This module is observability only: it reads the canonical controller result (and the technical
// outcome of the job) and renders Markdown. It never decides release readiness on its own, never
// mutates its inputs and never treats a green workflow as functional completion.

export const DELIVERY_SUMMARY_OUTCOMES = Object.freeze({
  completed: 'completed',
  blocked: 'blocked',
  technicalError: 'technical-error'
});

export const DELIVERY_SUMMARY_HEADINGS = Object.freeze({
  completed: 'DELIVERY V2: CONCLUIDA',
  blocked: 'DELIVERY V2: BLOQUEADA',
  technicalError: 'DELIVERY V2: ERRO TECNICO',
  userAction: 'ACAO DO USUARIO NECESSARIA'
});

const SHA_RE = /^[0-9a-f]{40}$/;
const FAILED_OUTCOMES = new Set(['failure', 'cancelled']);
const MAX_ERROR_MESSAGE_LENGTH = 2000;

function sha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SHA_RE.test(normalized) ? normalized : null;
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Values are rendered inside inline code spans and list items; backticks and line breaks would
// break the Markdown structure, so they are neutralized instead of dropped.
function inline(value) {
  return String(value).replace(/`/g, "'").replace(/\s*\r?\n\s*/g, ' ').trim();
}

function code(value) {
  return value == null || value === '' ? '_(ausente)_' : `\`${inline(value)}\``;
}

export function formatDeliveryBlocker(blocker) {
  if (blocker == null) return null;
  if (typeof blocker === 'string' || typeof blocker === 'number' || typeof blocker === 'boolean') return text(blocker);
  if (Array.isArray(blocker)) return blocker.map(formatDeliveryBlocker).filter(Boolean).join(', ') || null;
  const label = text(blocker.code) ?? text(blocker.id) ?? text(blocker.reason) ?? text(blocker.name) ?? text(blocker.message);
  const kind = text(blocker.kind) ?? text(blocker.type) ?? text(blocker.severity);
  const evidence = text(blocker.evidenceRef) ?? text(blocker.url);
  if (!label) return JSON.stringify(blocker);
  return `${kind ? `${kind}: ` : ''}${label}${evidence ? ` (evidencia: ${evidence})` : ''}`;
}

// Canonical completion evidence. Every condition is read from the controller's own release
// evaluation (evaluateOperationalRelease -> evaluateReleaseGate); nothing is recomputed here.
export function deliveryCompletionEvidence(result) {
  const reasons = [];
  const value = isObject(result) ? result : {};
  const materialHeadSha = sha(value.materialHeadSha);
  const operational = isObject(value.release) ? value.release : null;
  const gate = isObject(operational?.release) ? operational.release : null;
  const candidateSha = sha(gate?.candidateSha);
  const remoteHeadSha = sha(gate?.currentRemoteHeadSha);

  if (value.releaseReady !== true) reasons.push('release-ready-false');
  if (value.status !== 'ready-for-human-merge') reasons.push(`operational-state:${text(value.status) ?? 'missing'}`);
  if (!operational || operational.readiness !== true) reasons.push('operational-release-not-ready');
  if (!gate) reasons.push('release-gate-missing');
  else {
    if (gate.readiness !== true || gate.state !== 'ready-for-human-merge') reasons.push(`release-gate-state:${text(gate.state) ?? 'missing'}`);
    if (gate.requiredStatus?.state !== 'success') reasons.push(`release-status:${text(gate.requiredStatus?.state) ?? 'missing'}`);
  }
  if (!materialHeadSha) reasons.push('material-head-missing');
  if (gate && materialHeadSha && candidateSha !== materialHeadSha) {
    reasons.push(`release-gate-exact-head-mismatch: gate certificou ${candidateSha ?? '(ausente)'}; HEAD material atual ${materialHeadSha}`);
  }
  if (gate && materialHeadSha && remoteHeadSha !== materialHeadSha) {
    reasons.push(`release-gate-remote-head-mismatch: gate observou ${remoteHeadSha ?? '(ausente)'}; HEAD material atual ${materialHeadSha}`);
  }
  return Object.freeze({
    complete: reasons.length === 0,
    reasons: Object.freeze(reasons),
    certifiedHeadSha: reasons.length === 0 ? candidateSha : null,
    gate
  });
}

function technicalFailures(technical) {
  const value = isObject(technical) ? technical : {};
  const failures = [];
  for (const [label, outcome] of [
    ['job', value.jobStatus],
    ['guard de reentrada', value.guardOutcome],
    ['controller', value.controllerOutcome]
  ]) {
    const normalized = text(outcome)?.toLowerCase();
    if (normalized && FAILED_OUTCOMES.has(normalized)) failures.push(`${label}: ${normalized}`);
  }
  for (const error of Array.isArray(value.errors) ? value.errors : []) {
    const message = text(error?.message ?? error);
    if (message) failures.push(`${text(error?.source) ?? 'execucao'}: ${message}`);
  }
  return failures;
}

export function classifyDeliveryControllerOutcome({ result = null, technical = null } = {}) {
  const failures = technicalFailures(technical);
  if (failures.length > 0) return Object.freeze({ outcome: DELIVERY_SUMMARY_OUTCOMES.technicalError, technicalFailures: Object.freeze(failures) });
  if (!isObject(result)) {
    return Object.freeze({
      outcome: DELIVERY_SUMMARY_OUTCOMES.technicalError,
      technicalFailures: Object.freeze(['resultado do controller ausente: a execucao nao produziu estado funcional verificavel'])
    });
  }
  const completion = deliveryCompletionEvidence(result);
  return Object.freeze({
    outcome: completion.complete ? DELIVERY_SUMMARY_OUTCOMES.completed : DELIVERY_SUMMARY_OUTCOMES.blocked,
    technicalFailures: Object.freeze([])
  });
}

export function deliveryNextAction(result) {
  const value = isObject(result) ? result : {};
  return text(value.nextAction) ?? text(value.reentry?.nextAction) ?? text(value.dispatchDecision?.nextAction);
}

export function deliveryBlockers(result) {
  const value = isObject(result) ? result : {};
  const collected = [];
  const push = (items) => {
    for (const item of Array.isArray(items) ? items : [items]) {
      const formatted = formatDeliveryBlocker(item);
      if (formatted && !collected.includes(formatted)) collected.push(formatted);
    }
  };
  push(value.blockers);
  push(value.adoption?.blockers);
  if (value.release && value.release.readiness !== true) push(value.release.reasons);
  if (value.status !== 'ready-for-human-merge') push(value.terminalReason ?? value.metrics?.terminalReason ?? value.partialMetrics?.terminalReason);
  if (value.dispatchDecision && value.dispatchDecision.dispatchAllowed === false) push(value.dispatchDecision.reason);
  if (value.releaseReady === true) push(deliveryCompletionEvidence(value).reasons.filter((reason) => reason !== 'release-ready-false'));
  return Object.freeze(collected);
}

const RESUME = 'resume';
const ESCALATION = 'escalation';
const EXTERNAL_CI = 'external-ci';
const SCOPE = 'scope';
const FAILED_RUN = 'failed-run';
const RECERTIFY = 'recertify';

// Operational translation of every nextAction the controller, the reentry guard, the legacy
// adoption checkpoint and the persistent-state reconciler can emit. Anything not listed falls back
// to the safe "resume the cycle" guidance; it never implies completion.
const NEXT_ACTION_GUIDANCE = Object.freeze({
  'collect-adoption-evidence': { kind: RESUME, detail: 'A adocao do PR legado ainda nao tem a evidencia confiavel exigida (por exemplo, a continuacao de auditoria do HEAD atual). Publique a evidencia pendente e retome o ciclo.' },
  'collect-technical-hygiene-evidence': { kind: RESUME, detail: 'A evidencia de higiene tecnica do HEAD atual ainda precisa ser coletada.' },
  'checkout-current-pr': { kind: RESUME, detail: 'O checkout usado nao corresponde ao HEAD atual do PR; uma nova execucao faz o checkout do HEAD correto.' },
  'post-write-refreeze': { kind: RESUME, detail: 'O PR adotado precisa ser recongelado no HEAD atual.' },
  'dispatch-legacy-adoption-audit': { kind: RESUME, detail: 'A auditoria independente pos-adocao ainda precisa ser despachada.' },
  'resolve-legacy-adoption-audit-run': { kind: RESUME, detail: 'A execucao da auditoria pos-adocao ainda precisa ser correlacionada.' },
  'observe-legacy-adoption-audit': { kind: RESUME, detail: 'A auditoria pos-adocao ainda esta em andamento ou precisa ser observada.' },
  'dispatch-legacy-adoption-audit-remediation': { kind: RESUME, detail: 'A auditoria pos-adocao rejeitou o HEAD atual; a remediacao precisa ser despachada.' },
  classify: { kind: RESUME, detail: 'O HEAD material mudou e precisa ser reclassificado.' },
  implement: { kind: RESUME, detail: 'A implementacao ainda precisa ser despachada.' },
  'continue-implementation': { kind: RESUME, detail: 'A implementacao em andamento precisa ser retomada.' },
  'dispatch-initial-worker': { kind: RESUME, detail: 'A implementacao inicial ainda precisa ser despachada.' },
  'dispatch-material-worker': { kind: RESUME, detail: 'A implementacao inicial ainda precisa ser despachada.' },
  'dispatch-implementation': { kind: RESUME, detail: 'A implementacao ainda precisa ser despachada.' },
  'await-material-head': { kind: RESUME, detail: 'Aguardando a publicacao do HEAD material pela implementacao.' },
  'retry-initial-worker': { kind: RESUME, detail: 'A tentativa inicial de implementacao precisa ser repetida dentro do orcamento.' },
  'recover-initial-attempt': { kind: RESUME, detail: 'A tentativa inicial em andamento precisa ser recuperada.' },
  'observe-ci': { kind: RESUME, detail: 'A CI exata do HEAD atual ainda precisa ser observada.' },
  'exact-head-ci-required': { kind: RESUME, detail: 'A CI exata do HEAD atual ainda precisa ser observada.' },
  'remediate-ci': { kind: RESUME, detail: 'A CI falhou de forma remediavel; a remediacao precisa ser despachada.' },
  'dispatch-ci-remediation': { kind: RESUME, detail: 'A CI falhou de forma remediavel; a remediacao precisa ser despachada.' },
  'dispatch-remediation': { kind: RESUME, detail: 'A remediacao precisa ser despachada.' },
  'observe-remediation': { kind: RESUME, detail: 'A remediacao em andamento precisa ser observada.' },
  'dispatch-remediation-recovery': { kind: RESUME, detail: 'A recuperacao bounded de uma remediacao que falhou antes da publicacao precisa ser despachada.' },
  'observe-remediation-recovery': { kind: RESUME, detail: 'A recuperacao bounded da remediacao esta em andamento e precisa ser observada.' },
  'run-audit': { kind: RESUME, detail: 'A auditoria independente do HEAD atual ainda precisa ser executada.' },
  'dispatch-audit': { kind: RESUME, detail: 'A auditoria independente do HEAD atual ainda precisa ser despachada.' },
  'observe-audit': { kind: RESUME, detail: 'A auditoria independente em andamento precisa ser observada.' },
  'remediate-audit': { kind: RESUME, detail: 'A auditoria encontrou achados remediaveis; a remediacao precisa ser despachada.' },
  'dispatch-audit-remediation': { kind: RESUME, detail: 'A auditoria encontrou achados remediaveis; a remediacao precisa ser despachada.' },
  'resolve-technical-hygiene': { kind: RESUME, detail: 'A higiene tecnica do HEAD atual ainda precisa ser resolvida.' },
  'dispatch-technical-hygiene': { kind: RESUME, detail: 'A evidencia de higiene tecnica precisa ser despachada.' },
  'observe-technical-hygiene': { kind: RESUME, detail: 'A higiene tecnica em andamento precisa ser observada.' },
  'external-head-drift-requires-controller-resume': { kind: RESUME, detail: 'O HEAD do PR mudou fora do controller; a evidencia anterior nao vale para o novo HEAD.' },
  'evaluate-release-gate': { kind: RECERTIFY, detail: 'O release gate ainda precisa ser avaliado para o HEAD atual.' },
  'human-merge-policy': { kind: RECERTIFY, detail: 'O release gate registrado nao certifica o HEAD material atual.' },
  'queued': { kind: RESUME, detail: 'A entrega esta enfileirada e precisa ser classificada.' },
  'classified': { kind: RESUME, detail: 'A entrega esta classificada e a implementacao precisa ser despachada.' },
  'implementing': { kind: RESUME, detail: 'A implementacao em andamento precisa ser retomada.' },
  'ci-pending': { kind: RESUME, detail: 'A CI exata do HEAD atual ainda precisa ser observada.' },
  'ci-failed-remediable': { kind: RESUME, detail: 'A CI falhou de forma remediavel; a remediacao precisa ser despachada.' },
  'audit-pending': { kind: RESUME, detail: 'A auditoria independente do HEAD atual ainda precisa ser executada.' },
  'audit-failed-remediable': { kind: RESUME, detail: 'A auditoria encontrou achados remediaveis; a remediacao precisa ser despachada.' },
  'technical-hygiene-pending': { kind: RESUME, detail: 'A higiene tecnica do HEAD atual ainda precisa ser resolvida.' },
  'ready-for-human-merge': { kind: RECERTIFY, detail: 'O release gate ainda precisa certificar o HEAD atual.' },
  'human-escalation': { kind: ESCALATION, detail: 'O controller escalou a entrega para decisao humana (orcamento esgotado, risco maior ou bloqueio nao remediavel).' },
  escalated: { kind: ESCALATION, detail: 'O controller escalou a entrega para decisao humana.' },
  'external-ci-blocker': { kind: EXTERNAL_CI, detail: 'A CI obrigatoria terminou com conclusao externa/ambigua; o controller recusa remediacao por IA.' },
  'collect-concrete-changed-paths': { kind: SCOPE, detail: 'Nao foi possivel derivar deterministicamente os caminhos alterados a partir da issue.' },
  'needs-scope': { kind: SCOPE, detail: 'Nao foi possivel derivar deterministicamente os caminhos alterados a partir da issue.' },
  'audit-workflow-failed': { kind: FAILED_RUN, detail: 'O workflow de auditoria independente falhou.' },
  'remediation-worker-failed': { kind: FAILED_RUN, detail: 'O worker de remediacao falhou.' },
  'technical-hygiene-worker-failed': { kind: FAILED_RUN, detail: 'O worker de evidencia de higiene tecnica falhou.' }
});

function orchestratorCommand(issueNumber) {
  return `@Orquestrador Issue ${issueNumber ?? '<numero>'}`;
}

function dispatchCommand({ repository, issueNumber, baseBranch }, { changedPaths = false } = {}) {
  if (!repository || !issueNumber) return null;
  return [
    'gh workflow run delivery-v2-dispatch.yml',
    `-f target_repository=${repository}`,
    `-f target_issue=${issueNumber}`,
    ...(baseBranch ? [`-f base_branch=${baseBranch}`] : []),
    ...(changedPaths ? ['-f changed_paths="<caminhos esperados>"'] : [])
  ].join(' ');
}

export function operationalGuidanceForDelivery({ result = null, identity = {}, outcome } = {}) {
  const value = isObject(result) ? result : {};
  const nextAction = deliveryNextAction(value);
  const resume = orchestratorCommand(identity.issueNumber);
  if (outcome === DELIVERY_SUMMARY_OUTCOMES.completed) {
    return Object.freeze({
      kind: 'manual-merge',
      steps: Object.freeze([
        'Nenhuma acao adicional do controller e necessaria antes do merge manual.',
        'O merge e uma decisao humana; o controller nao faz merge automaticamente.'
      ]),
      commands: Object.freeze([])
    });
  }
  if (outcome === DELIVERY_SUMMARY_OUTCOMES.technicalError) {
    return Object.freeze({
      kind: 'technical-error',
      steps: Object.freeze([
        'Analise o log da execucao e a falha tecnica listada acima; ela nao e um bloqueio funcional normal.',
        'Depois de corrigir a causa tecnica, retome o ciclo com uma nova execucao do orquestrador.'
      ]),
      commands: Object.freeze([resume, dispatchCommand(identity)].filter(Boolean))
    });
  }
  const known = (key) => (key && Object.hasOwn(NEXT_ACTION_GUIDANCE, key) ? NEXT_ACTION_GUIDANCE[key] : null);
  // Escalation is authoritative even when the last persisted nextAction was an in-flight step.
  const entry = value.status === 'escalated' || value.status === 'escalated-initial-budget-exhausted'
    ? NEXT_ACTION_GUIDANCE['human-escalation']
    : known(nextAction) ?? known(text(value.status));
  if (!entry) {
    return Object.freeze({
      kind: 'fallback',
      steps: Object.freeze([
        nextAction
          ? `O controller informou nextAction \`${inline(nextAction)}\`, que nao possui traducao operacional conhecida.`
          : 'O controller nao informou nextAction para esta entrega bloqueada.',
        'A entrega NAO esta pronta para merge. Revise os blockers acima e retome o ciclo com uma nova execucao do orquestrador.'
      ]),
      commands: Object.freeze([resume, dispatchCommand(identity)].filter(Boolean))
    });
  }
  const stepsByKind = {
    [RESUME]: ['Retome o ciclo com uma nova execucao do orquestrador.'],
    [RECERTIFY]: ['A entrega NAO esta pronta para merge. Retome o ciclo com uma nova execucao do orquestrador para certificar o HEAD material atual.'],
    [ESCALATION]: ['Intervencao humana necessaria: analise o motivo da escalada e os blockers acima.', 'Apos a decisao humana, retome o ciclo com uma nova execucao do orquestrador.'],
    [EXTERNAL_CI]: ['Corrija ou reexecute a CI obrigatoria fora do controller (falha externa/ambigua).', 'Com a CI do HEAD atual verde, retome o ciclo com uma nova execucao do orquestrador.'],
    [SCOPE]: ['Informe os caminhos esperados (`changed_paths`) na issue ou no dispatch e retome o ciclo.'],
    [FAILED_RUN]: ['Analise a execucao que falhou (link no estado do PR ou nos logs).', 'Depois de corrigir a causa, retome o ciclo com uma nova execucao do orquestrador.']
  };
  return Object.freeze({
    kind: entry.kind,
    steps: Object.freeze([entry.detail, ...stepsByKind[entry.kind]]),
    commands: Object.freeze([resume, dispatchCommand(identity, { changedPaths: entry.kind === SCOPE })].filter(Boolean))
  });
}

function resolveIdentity(result, identity) {
  const value = isObject(result) ? result : {};
  const fallback = isObject(identity) ? identity : {};
  const issue = Number(value.issueNumber ?? fallback.issueNumber);
  return Object.freeze({
    repository: text(value.repository) ?? text(fallback.repository),
    issueNumber: Number.isInteger(issue) && issue > 0 ? issue : null,
    pullRequestNumber: value.pullRequestNumber ?? fallback.pullRequestNumber ?? null,
    materialHeadSha: sha(value.materialHeadSha) ?? sha(fallback.materialHeadSha),
    baseBranch: text(fallback.baseBranch),
    runUrl: text(fallback.runUrl)
  });
}

function releaseGateLabel(result) {
  const operational = isObject(result?.release) ? result.release : null;
  const gate = isObject(operational?.release) ? operational.release : null;
  if (!gate) return null;
  const status = gate.requiredStatus ? `${gate.requiredStatus.name ?? 'release status'}: ${gate.requiredStatus.state ?? '?'}` : null;
  return `${gate.state ?? '?'}${status ? ` (${status})` : ''}`;
}

function field(label, value) {
  return `| ${label} | ${value} |`;
}

export function buildDeliveryControllerSummary({ result = null, identity = {}, technical = null } = {}) {
  const value = isObject(result) ? result : null;
  const resolved = resolveIdentity(value, identity);
  const classification = classifyDeliveryControllerOutcome({ result: value, technical });
  const { outcome } = classification;
  const completion = deliveryCompletionEvidence(value);
  const nextAction = deliveryNextAction(value);
  const blockers = value ? deliveryBlockers(value) : [];
  const guidance = operationalGuidanceForDelivery({ result: value, identity: resolved, outcome });
  const phase = text(value?.phase) ?? text(value?.status) ?? text(value?.reentry?.persistedStatus);
  const pr = resolved.pullRequestNumber
    ? (resolved.repository ? `[#${resolved.pullRequestNumber}](https://github.com/${resolved.repository}/pull/${resolved.pullRequestNumber})` : `#${resolved.pullRequestNumber}`)
    : '_(ausente)_';
  const issue = resolved.issueNumber
    ? (resolved.repository ? `[#${resolved.issueNumber}](https://github.com/${resolved.repository}/issues/${resolved.issueNumber})` : `#${resolved.issueNumber}`)
    : '_(ausente)_';

  const lines = [];
  if (outcome === DELIVERY_SUMMARY_OUTCOMES.completed) {
    lines.push(`# ${DELIVERY_SUMMARY_HEADINGS.completed}`, '', '> Release gate exact-head aprovado para o HEAD material atual. Nenhuma acao adicional do controller e necessaria antes do merge manual.');
  } else if (outcome === DELIVERY_SUMMARY_OUTCOMES.technicalError) {
    lines.push(`# ${DELIVERY_SUMMARY_HEADINGS.technicalError}`, '', `## ${DELIVERY_SUMMARY_HEADINGS.userAction}`, '', '> A execucao tecnica falhou. A entrega **nao** foi concluida e nao deve ser tratada como pronta para merge.');
  } else {
    lines.push(`# ${DELIVERY_SUMMARY_HEADINGS.blocked}`, '', `## ${DELIVERY_SUMMARY_HEADINGS.userAction}`, '', '> A entrega funcional esta bloqueada. Um workflow tecnicamente verde **nao** significa entrega concluida.');
  }

  lines.push('', '| Campo | Valor |', '| --- | --- |',
    field('Repository', code(resolved.repository)),
    field('Issue', issue),
    field('PR', pr),
    field('HEAD material (exact-head)', code(resolved.materialHeadSha)),
    field('Phase', code(phase)),
    field('Status', code(value?.status)),
    field('Release ready', code(value?.releaseReady === true ? 'true' : 'false')),
    field('Release gate', code(releaseGateLabel(value))),
    field('nextAction (interno)', code(nextAction)));
  if (outcome === DELIVERY_SUMMARY_OUTCOMES.completed) lines.push(field('HEAD certificado', code(completion.certifiedHeadSha)));
  if (resolved.runUrl) lines.push(field('Execucao', resolved.runUrl));

  if (outcome === DELIVERY_SUMMARY_OUTCOMES.technicalError) {
    lines.push('', '### Falha tecnica', '', ...classification.technicalFailures.map((failure) => `- ${inline(failure)}`));
  }

  if (outcome !== DELIVERY_SUMMARY_OUTCOMES.completed) {
    lines.push('', `### Blockers (${blockers.length})`, '');
    if (blockers.length) lines.push(...blockers.map((blocker) => `- \`${inline(blocker)}\``));
    else lines.push(value ? '- _Nenhum blocker explicito foi reportado pelo controller; a entrega continua nao concluida._' : '- _Estado funcional indisponivel._');
  }

  lines.push('', '### Proximo passo', '', ...guidance.steps.map((step) => `- ${step}`));
  if (guidance.commands.length) lines.push('', '```text', ...guidance.commands, '```');

  if (value) {
    lines.push('', '<details><summary>Resultado bruto do controller (diagnostico)</summary>', '', '```json', JSON.stringify(value, null, 2), '```', '', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

export async function appendDeliveryControllerSummary(markdown, { summaryPath = process.env.GITHUB_STEP_SUMMARY, append = appendFile } = {}) {
  const target = text(summaryPath);
  if (!target) return false;
  await append(target, markdown, 'utf8');
  return true;
}

// Records a technical failure so the summary step can distinguish it from a functional block.
// The stderr stack trace remains the primary diagnostic; this only carries the message forward.
export async function recordControllerTechnicalError(error, { source = 'controller', errorPath = process.env.CONTROLLER_ERROR_PATH, append = appendFile } = {}) {
  const target = text(errorPath);
  if (!target) return false;
  const message = String(error?.message ?? error ?? 'unknown error').slice(0, MAX_ERROR_MESSAGE_LENGTH);
  await append(target, `${JSON.stringify({ source, message })}\n`, 'utf8');
  return true;
}

export function parseControllerTechnicalErrors(raw) {
  return String(raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      const parsed = JSON.parse(line);
      return isObject(parsed) ? { source: text(parsed.source) ?? 'execucao', message: text(parsed.message) ?? line } : { source: 'execucao', message: line };
    } catch {
      return { source: 'execucao', message: line };
    }
  });
}
