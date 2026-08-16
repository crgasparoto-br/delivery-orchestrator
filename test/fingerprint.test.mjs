import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFingerprint } from '../src/fingerprint.mjs';

test('finding order does not change audit fingerprint', () => {
  const a = { findings: [
    { severity: 'high', requirement: 'R2', cause: 'c2', remediation: 'x2', fingerprint: 'f2' },
    { severity: 'high', requirement: 'R1', cause: 'c1', remediation: 'x1', fingerprint: 'f1' }
  ]};
  const b = { findings: [...a.findings].reverse() };
  assert.equal(auditFingerprint(a), auditFingerprint(b));
});
