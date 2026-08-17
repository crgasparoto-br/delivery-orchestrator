import { createHash } from 'node:crypto';

export function auditFingerprint(audit) {
  const normalized = [...(audit.findings ?? [])]
    .map(f => ({ severity: f.severity, requirement: f.requirement, cause: f.cause, remediation: f.remediation, fingerprint: f.fingerprint }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function ciFingerprint(runs = []) {
  const normalized = [...runs]
    .map(run => ({ name: run.name, event: run.event, conclusion: run.conclusion }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
