import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { STATES } from './constants.mjs';
import { auditFingerprint } from './fingerprint.mjs';
import { copyDir, resetDir, writeJson } from './files.mjs';
import { cloneForAudit, cloneForImplementation, verifyAuditWorkspaceClean } from './git-workspace.mjs';
import { loadPrompt } from './prompts.mjs';
import { AUDIT_RESULT_SCHEMA, IMPLEMENTER_RESULT_SCHEMA } from './schemas.mjs';
import { prepareSkillHomes } from './skill-homes.mjs';
import { initialState, transition } from './state-machine.mjs';

function mapImplementerBlock(status) {
  if (status === 'blocked_requirement') return STATES.BLOCKED_REQUIREMENT;
  if (status === 'blocked_external') return STATES.BLOCKED_EXTERNAL;
  return STATES.FAILED;
}

export async function runDelivery(config, executor) {
  const runId = config.runId ?? randomUUID();
  const runDir = path.join(config.runsRoot, runId);
  const runtimeRoot = path.join(runDir, 'runtime');
  await mkdir(runDir, { recursive: true });
  let state = initialState({ runId, repository: config.repository, issueNumber: config.issueNumber, maxCycles: config.maxCycles });
  const persist = async () => writeJson(path.join(runDir, 'state.json'), state);
  await persist();

  const homes = await prepareSkillHomes({ runtimeRoot, catalog: config.skillCatalog, auditorPrivateKeyB64: config.auditorPrivateKeyB64 });
  const implementerWorkspace = path.join(runtimeRoot, 'implementation', 'repo');
  await cloneForImplementation({ repository: config.repository, dest: implementerWorkspace, token: config.writeToken });

  let previousAudit = null;
  let previousFingerprint = null;
  let previousRejectedHead = null;
  let stagnantCount = 0;

  for (let cycle = 1; cycle <= config.maxCycles; cycle += 1) {
    state.cycle = cycle;
    state = transition(state, cycle === 1 ? STATES.IMPLEMENTING : STATES.REMEDIATING, { cycle });
    await persist();

    const implementerPrompt = await loadPrompt(config.implementerPrompt, {
      repository: config.repository,
      issue_number: config.issueNumber,
      cycle,
      audit_findings: previousAudit ? JSON.stringify(previousAudit.findings, null, 2) : '[]'
    });

    const implRun = await executor.runFresh({
      workingDirectory: implementerWorkspace,
      codexHome: homes.implementer,
      prompt: implementerPrompt,
      outputSchema: IMPLEMENTER_RESULT_SCHEMA,
      role: 'implementer',
      githubToken: config.writeToken,
      sandboxMode: config.sandboxMode
    });
    state.implementation_context_ids.push(implRun.contextId);
    await writeJson(path.join(runDir, `cycle-${cycle}-implementation.json`), implRun);

    if (implRun.result.status !== 'ready_for_audit') {
      state = transition(state, mapImplementerBlock(implRun.result.status), { cycle, reason: implRun.result.blocking_reason ?? implRun.result.summary });
      await persist();
      return state;
    }
    if (!implRun.result.material_head_sha || !implRun.result.handoff_head_sha) {
      state = transition(state, STATES.FAILED, { cycle, reason: 'implementer omitted certified head identity' });
      await persist();
      return state;
    }
    state.material_head_sha = implRun.result.material_head_sha;
    state.handoff_head_sha = implRun.result.handoff_head_sha;
    state = transition(state, STATES.HANDOFF_READY, { cycle, material_head_sha: state.material_head_sha, handoff_head_sha: state.handoff_head_sha });
    await persist();

    const auditorWorkspace = path.join(runtimeRoot, `audit-${cycle}`, 'repo');
    await cloneForAudit({ repository: config.repository, dest: auditorWorkspace, ref: state.handoff_head_sha, token: config.readToken });
    state = transition(state, STATES.AUDITING, { cycle });
    await persist();

    const trustedAuditorsPath = config.trustedAuditorsPath
      ? path.resolve(config.trustedAuditorsPath)
      : path.join(auditorWorkspace, 'trusted-auditors.json');
    const auditOutputDir = path.join(os.tmpdir(), `delivery-orchestrator-${runId}-audit-${cycle}`);
    await resetDir(auditOutputDir);
    const auditPrompt = await loadPrompt(config.auditorPrompt, {
      repository: config.repository,
      issue_number: config.issueNumber,
      cycle,
      material_head_sha: state.material_head_sha,
      handoff_head_sha: state.handoff_head_sha,
      auditor_key_id: config.auditorKeyId ?? 'not-configured',
      auditor_private_key_path: homes.auditorPrivateKeyPath ?? 'not-configured',
      trusted_auditors_path: trustedAuditorsPath,
      audit_output_dir: auditOutputDir
    });

    const auditRun = await executor.runFresh({
      workingDirectory: auditorWorkspace,
      codexHome: homes.auditor,
      prompt: auditPrompt,
      outputSchema: AUDIT_RESULT_SCHEMA,
      role: 'auditor',
      githubToken: config.readToken,
      sandboxMode: config.sandboxMode,
      extraEnv: {
        AUDITOR_KEY_PASSWORD: config.auditorKeyPassword ?? '',
        AUDITOR_KEY_ID: config.auditorKeyId ?? '',
        AUDIT_OUTPUT_DIR: auditOutputDir
      }
    });
    try {
      await verifyAuditWorkspaceClean({ cwd: auditorWorkspace, expectedHead: state.handoff_head_sha });
    } catch (error) {
      state = transition(state, STATES.FAILED, { cycle, reason: `independence violation: ${error.message}` });
      await persist();
      return state;
    }
    await copyDir(auditOutputDir, path.join(runDir, `cycle-${cycle}-audit-output`));

    state.audit_context_ids.push(auditRun.contextId);
    state.last_audit = auditRun.result;
    await writeJson(path.join(runDir, `cycle-${cycle}-audit.json`), auditRun);

    if (auditRun.contextId && implRun.contextId && auditRun.contextId === implRun.contextId) {
      state = transition(state, STATES.FAILED, { cycle, reason: 'independence violation: implementation and audit context ids are equal' });
      await persist();
      return state;
    }

    if ((auditRun.result.status === 'approved' || auditRun.result.status === 'approved_with_reservations') &&
        auditRun.result.validity === 'independent' && auditRun.result.release_gate_satisfied) {
      state = transition(state, STATES.COMPLETE, { cycle, verdict: auditRun.result.status });
      await persist();
      return state;
    }

    if (auditRun.result.status === 'inconclusive') {
      state = transition(state, STATES.BLOCKED_EXTERNAL, { cycle, reason: auditRun.result.limitations.join('; ') || auditRun.result.summary });
      await persist();
      return state;
    }

    if (auditRun.result.status !== 'rejected') {
      state = transition(state, STATES.FAILED, { cycle, reason: `non-releasable audit result: ${auditRun.result.status}/${auditRun.result.validity}` });
      await persist();
      return state;
    }

    const fp = auditFingerprint(auditRun.result);
    state.audit_fingerprints.push(fp);
    if (fp === previousFingerprint && state.material_head_sha === previousRejectedHead) stagnantCount += 1;
    else stagnantCount = 0;
    if (stagnantCount >= config.maxStagnantCycles) {
      state = transition(state, STATES.NO_PROGRESS, { cycle, fingerprint: fp });
      await persist();
      return state;
    }
    previousFingerprint = fp;
    previousRejectedHead = state.material_head_sha;
    previousAudit = auditRun.result;
  }

  state = transition(state, STATES.NO_PROGRESS, { reason: `max cycles reached (${config.maxCycles})` });
  await persist();
  return state;
}
