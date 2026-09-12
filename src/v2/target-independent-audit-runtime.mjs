import { createHash } from 'node:crypto';
import { buildAuditRequest } from './audit-contract.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const TARGET_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}
function string(value, label) {
  const resolved = String(value ?? '').trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}
function positiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
function sha(value, label) {
  const resolved = string(value, label).toLowerCase();
  if (!SHA_RE.test(resolved)) throw new Error(`${label} must be a 40-character Git commit SHA`);
  return resolved;
}
function fingerprintValue(value, label) {
  const resolved = string(value, label).toLowerCase();
  if (!FINGERPRINT_RE.test(resolved)) throw new Error(`${label} must be a 64-character SHA-256 fingerprint`);
  return resolved;
}
function repository(value) {
  const resolved = string(value, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolved)) throw new Error('repository must use owner/name form');
  return resolved;
}
function fingerprint(content) {
  return createHash('sha256').update(string(content, 'evidence content')).digest('hex');
}
function fileEvidence(value, label, expectedPath, expectedRef) {
  const evidence = object(value, label);
  const path = string(evidence.path, `${label}.path`);
  if (path !== expectedPath) throw new Error(`${label}.path must be ${expectedPath}`);
  const ref = sha(evidence.ref, `${label}.ref`);
  if (ref !== expectedRef) throw new Error(`${label}.ref does not match configured target identity`);
  return Object.freeze({
    path,
    ref,
    blobSha: sha(evidence.blobSha, `${label}.blobSha`),
    content: string(evidence.content, `${label}.content`)
  });
}

export function normalizeTargetAuditConfig(raw) {
  const value = object(raw, 'target audit config');
  if (value.schemaVersion !== 1) throw new Error('target audit config schemaVersion must be 1');
  const id = string(value.id, 'id').toLowerCase();
  if (!TARGET_ID_RE.test(id)) throw new Error('id must be a lowercase target-audit identifier');
  const workflow = object(value.sourceWorkflow, 'sourceWorkflow');
  const event = string(workflow.event, 'sourceWorkflow.event').toLowerCase();
  if (event !== 'pull_request') throw new Error('sourceWorkflow.event must be pull_request');
  const mergePreviewSha = sha(value.mergePreviewSha, 'mergePreviewSha');
  const mergeCommitSha = sha(value.mergeCommitSha, 'mergeCommitSha');
  if (mergePreviewSha === mergeCommitSha) throw new Error('mergePreviewSha and mergeCommitSha must represent distinct identities');
  return Object.freeze({
    schemaVersion: 1,
    id,
    repository: repository(value.repository),
    issueNumber: positiveInt(value.issueNumber, 'issueNumber'),
    pullRequestNumber: positiveInt(value.pullRequestNumber, 'pullRequestNumber'),
    baseRef: string(value.baseRef, 'baseRef'),
    baseSha: sha(value.baseSha, 'baseSha'),
    headRef: string(value.headRef, 'headRef'),
    materialHeadSha: sha(value.materialHeadSha, 'materialHeadSha'),
    mergePreviewSha,
    mergeCommitSha,
    classifierPath: string(value.classifierPath, 'classifierPath'),
    sourceWorkflow: Object.freeze({
      runId: positiveInt(workflow.runId, 'sourceWorkflow.runId'),
      workflowId: positiveInt(workflow.workflowId, 'sourceWorkflow.workflowId'),
      name: string(workflow.name, 'sourceWorkflow.name'),
      path: string(workflow.path, 'sourceWorkflow.path'),
      event,
      bindingJobName: string(workflow.bindingJobName, 'sourceWorkflow.bindingJobName')
    }),
    purpose: string(value.purpose, 'purpose')
  });
}

export function normalizeTargetSourceBindingEvidence(raw, configInput) {
  const config = normalizeTargetAuditConfig(configInput);
  const value = object(raw, 'sourceWorkflowBindingEvidence');
  const jobName = string(value.jobName, 'sourceWorkflowBindingEvidence.jobName');
  if (jobName !== config.sourceWorkflow.bindingJobName) throw new Error('source workflow binding job name does not match target audit config');
  const status = string(value.status, 'sourceWorkflowBindingEvidence.status').toLowerCase();
  const conclusion = string(value.conclusion, 'sourceWorkflowBindingEvidence.conclusion').toLowerCase();
  if (status !== 'completed' || conclusion !== 'success') throw new Error('source workflow binding job must be terminal green');
  const pullRequestNumber = positiveInt(value.pullRequestNumber, 'sourceWorkflowBindingEvidence.pullRequestNumber');
  if (pullRequestNumber !== config.pullRequestNumber) throw new Error('source workflow binding evidence does not match configured pull request');
  const mergePreviewSha = sha(value.mergePreviewSha, 'sourceWorkflowBindingEvidence.mergePreviewSha');
  if (mergePreviewSha !== config.mergePreviewSha) throw new Error('source workflow binding evidence does not match configured merge preview');
  const materialHeadSha = sha(value.materialHeadSha, 'sourceWorkflowBindingEvidence.materialHeadSha');
  if (materialHeadSha !== config.materialHeadSha) throw new Error('source workflow binding evidence does not match configured material head');
  return Object.freeze({
    jobId: positiveInt(value.jobId, 'sourceWorkflowBindingEvidence.jobId'),
    jobName,
    status,
    conclusion,
    pullRequestNumber,
    mergePreviewSha,
    materialHeadSha,
    logFingerprint: fingerprintValue(value.logFingerprint, 'sourceWorkflowBindingEvidence.logFingerprint')
  });
}

export function normalizeTargetAuditRuntimeEvidence(raw) {
  const value = object(raw, 'auditRuntimeEvidence');
  return Object.freeze({
    runtimeSha: sha(value.runtimeSha, 'auditRuntimeEvidence.runtimeSha'),
    contractFingerprint: fingerprintValue(value.contractFingerprint, 'auditRuntimeEvidence.contractFingerprint'),
    targetConfigFingerprint: fingerprintValue(value.targetConfigFingerprint, 'auditRuntimeEvidence.targetConfigFingerprint'),
    runnerFingerprint: fingerprintValue(value.runnerFingerprint, 'auditRuntimeEvidence.runnerFingerprint'),
    targetRuntimeFingerprint: fingerprintValue(value.targetRuntimeFingerprint, 'auditRuntimeEvidence.targetRuntimeFingerprint'),
    workflowFingerprint: fingerprintValue(value.workflowFingerprint, 'auditRuntimeEvidence.workflowFingerprint')
  });
}

export function assertTargetPullRequest(configInput, pullRequest) {
  const config = normalizeTargetAuditConfig(configInput);
  const pr = object(pullRequest, 'pullRequest');
  if (positiveInt(pr.number, 'pullRequest.number') !== config.pullRequestNumber) throw new Error('pull request number does not match target audit config');
  if (string(pr.base?.repo?.full_name, 'pullRequest.base.repo.full_name') !== config.repository) throw new Error('pull request base repository does not match target audit config');
  if (string(pr.head?.repo?.full_name, 'pullRequest.head.repo.full_name') !== config.repository) throw new Error('pull request head repository does not match target audit config');
  if (string(pr.base?.ref, 'pullRequest.base.ref') !== config.baseRef) throw new Error('pull request base ref does not match target audit config');
  if (sha(pr.base?.sha, 'pullRequest.base.sha') !== config.baseSha) throw new Error('pull request base SHA does not match target audit config');
  if (string(pr.head?.ref, 'pullRequest.head.ref') !== config.headRef) throw new Error('pull request head ref does not match target audit config');
  if (sha(pr.head?.sha, 'pullRequest.head.sha') !== config.materialHeadSha) throw new Error('pull request material head does not match target audit config');
  if (sha(pr.merge_commit_sha, 'pullRequest.merge_commit_sha') !== config.mergeCommitSha) throw new Error('pull request merge commit does not match target audit config');
  if (pr.merged !== true) throw new Error('historical target pull request must be merged');
  return Object.freeze({ config, pullRequest: pr });
}

export function assertTargetSourceWorkflow(configInput, pullRequest, sourceWorkflowRun, sourceWorkflowDefinition, sourceWorkflowBindingEvidence) {
  const { config, pullRequest: pr } = assertTargetPullRequest(configInput, pullRequest);
  const run = object(sourceWorkflowRun, 'sourceWorkflowRun');
  const definition = object(sourceWorkflowDefinition, 'sourceWorkflowDefinition');
  const binding = normalizeTargetSourceBindingEvidence(sourceWorkflowBindingEvidence, config);
  if (positiveInt(run.id, 'sourceWorkflowRun.id') !== config.sourceWorkflow.runId) throw new Error('source workflow run id does not match target audit config');
  if (positiveInt(run.workflow_id, 'sourceWorkflowRun.workflow_id') !== config.sourceWorkflow.workflowId) throw new Error('source workflow id does not match target audit config');
  if (string(run.name, 'sourceWorkflowRun.name') !== config.sourceWorkflow.name) throw new Error('source workflow name does not match target audit config');
  if (string(run.path, 'sourceWorkflowRun.path') !== config.sourceWorkflow.path) throw new Error('source workflow path does not match target audit config');
  if (string(run.event, 'sourceWorkflowRun.event').toLowerCase() !== config.sourceWorkflow.event) throw new Error('source workflow event does not match target audit config');
  if (string(run.repository?.full_name, 'sourceWorkflowRun.repository.full_name') !== config.repository) throw new Error('source workflow repository does not match target audit config');
  if (sha(run.head_sha, 'sourceWorkflowRun.head_sha') !== config.materialHeadSha) throw new Error('source workflow run is stale for target candidate');
  if (string(run.head_branch, 'sourceWorkflowRun.head_branch') !== config.headRef) throw new Error('source workflow head branch does not match target audit config');
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('source workflow must be terminal green');

  if (positiveInt(definition.id, 'sourceWorkflowDefinition.id') !== config.sourceWorkflow.workflowId) throw new Error('resolved workflow definition id does not match target audit config');
  if (string(definition.name, 'sourceWorkflowDefinition.name') !== config.sourceWorkflow.name) throw new Error('resolved workflow definition name does not match target audit config');
  if (string(definition.path, 'sourceWorkflowDefinition.path') !== config.sourceWorkflow.path) throw new Error('resolved workflow definition path does not match target audit config');
  if (string(definition.state, 'sourceWorkflowDefinition.state').toLowerCase() !== 'active') throw new Error('resolved workflow definition must be active');

  if (Array.isArray(run.pull_requests) && run.pull_requests.length > 0) {
    const conflicting = run.pull_requests.some((candidate) => Number(candidate.number) !== config.pullRequestNumber);
    if (conflicting) throw new Error('source workflow run contains a conflicting pull request association');
  }
  return Object.freeze({ config, pullRequest: pr, run, definition, binding });
}

export function buildTargetCriticalAuditRequest({
  config: configInput,
  pullRequest,
  changedPaths,
  sourceWorkflowRun,
  sourceWorkflowDefinition,
  sourceWorkflowBindingEvidence,
  candidateWorkflowEvidence,
  baseWorkflowEvidence,
  classifierSource,
  auditRuntimeEvidence
} = {}) {
  const { config, pullRequest: pr, run, binding } = assertTargetSourceWorkflow(
    configInput,
    pullRequest,
    sourceWorkflowRun,
    sourceWorkflowDefinition,
    sourceWorkflowBindingEvidence
  );
  const runtime = normalizeTargetAuditRuntimeEvidence(auditRuntimeEvidence);
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('changedPaths must be a non-empty array');
  if (!changedPaths.includes(config.sourceWorkflow.path)) throw new Error('target audit expects the source workflow itself in changed paths');

  const candidateWorkflow = fileEvidence(
    candidateWorkflowEvidence,
    'candidateWorkflowEvidence',
    config.sourceWorkflow.path,
    config.materialHeadSha
  );
  const baseWorkflow = fileEvidence(
    baseWorkflowEvidence,
    'baseWorkflowEvidence',
    config.sourceWorkflow.path,
    config.baseSha
  );
  const candidateWorkflowFingerprint = fingerprint(candidateWorkflow.content);
  const baseWorkflowFingerprint = fingerprint(baseWorkflow.content);
  const classifierFingerprint = fingerprint(classifierSource);
  const workflowEvidence = Object.freeze({
    workflowId: config.sourceWorkflow.workflowId,
    path: config.sourceWorkflow.path,
    state: 'active',
    trustedBaseSha: config.baseSha,
    blobSha: baseWorkflow.blobSha,
    fingerprint: baseWorkflowFingerprint
  });

  const baseRequest = buildAuditRequest({
    schemaVersion: 1,
    repository: config.repository,
    issueNumber: config.issueNumber,
    pullRequestNumber: config.pullRequestNumber,
    baseRef: config.baseRef,
    baseSha: config.baseSha,
    headRef: config.headRef,
    materialHeadSha: config.materialHeadSha,
    mergePreviewSha: config.mergePreviewSha,
    risk: {
      profile: 'critical',
      reasons: ['dv2-target-historical-independent-audit', 'candidate-modified-ci-workflow']
    },
    classifier: {
      version: 'target-candidate-risk-profile-source-sha256',
      fingerprint: classifierFingerprint
    },
    checks: [{
      name: config.sourceWorkflow.name,
      required: true,
      scope: 'material-head',
      subjectSha: config.materialHeadSha,
      status: run.status,
      conclusion: run.conclusion,
      workflowRunId: config.sourceWorkflow.runId,
      workflowEvidence
    }, {
      name: config.sourceWorkflow.bindingJobName,
      required: true,
      scope: 'merge-preview',
      subjectSha: config.mergePreviewSha,
      status: binding.status,
      conclusion: binding.conclusion,
      workflowRunId: config.sourceWorkflow.runId,
      workflowEvidence
    }],
    changedPaths,
    implementationAttempt: 1,
    implementer: {
      provider: 'github',
      workerIdentity: `github-pr-author:${string(pr.user?.login, 'pullRequest.user.login')}`,
      runId: config.pullRequestNumber
    },
    priorFindings: []
  });

  const { requestFingerprint: _discard, ...baseWithoutFingerprint } = baseRequest;
  const requestBody = {
    ...baseWithoutFingerprint,
    targetAudit: Object.freeze({
      id: config.id,
      purpose: config.purpose,
      historicalMergedCandidate: true,
      mergePreviewSha: config.mergePreviewSha,
      mergeCommitSha: config.mergeCommitSha,
      sourceCiTrust: 'candidate-workflow-under-independent-review',
      runtime,
      sourceWorkflow: Object.freeze({
        runId: config.sourceWorkflow.runId,
        workflowId: config.sourceWorkflow.workflowId,
        name: config.sourceWorkflow.name,
        path: config.sourceWorkflow.path,
        event: config.sourceWorkflow.event,
        bindingEvidence: binding,
        candidate: Object.freeze({
          ref: candidateWorkflow.ref,
          blobSha: candidateWorkflow.blobSha,
          fingerprint: candidateWorkflowFingerprint
        }),
        trustedBase: Object.freeze({
          ref: baseWorkflow.ref,
          blobSha: baseWorkflow.blobSha,
          fingerprint: baseWorkflowFingerprint
        }),
        candidateDiffersFromBase: candidateWorkflow.blobSha !== baseWorkflow.blobSha || candidateWorkflowFingerprint !== baseWorkflowFingerprint,
        pullRequestAssociationsObserved: Array.isArray(run.pull_requests) ? run.pull_requests.length : 0,
        historicalAssociationPolicy: 'source-job-log-pr-ref-required'
      })
    })
  };
  const requestFingerprint = createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
  return Object.freeze({ ...requestBody, requestFingerprint });
}
