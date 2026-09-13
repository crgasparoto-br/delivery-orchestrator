import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrustedJsonEnvelope, selectTrustedMarkerComment, validateControllerRunProvenance } from '../src/v2/controller-provenance.mjs';

const marker = '<!-- delivery-v2-state -->';
const body = marker + '\n\n' + String.fromCharCode(96).repeat(3) + 'json\n{"ok":true}\n' + String.fromCharCode(96).repeat(3);

test('controller state comments require trusted authorship before JSON becomes authoritative', () => {
  const trusted = { id: 1, body, user: { login: 'owner' }, author_association: 'OWNER' };
  assert.equal(selectTrustedMarkerComment([trusted], { marker, label: 'state', trustedLogin: 'owner' }).id, 1);
  assert.equal(parseTrustedJsonEnvelope([trusted], { marker, label: 'state', trustedLogin: 'owner' }).value.ok, true);
  assert.throws(() => parseTrustedJsonEnvelope([{ ...trusted, user: { login: 'attacker' }, author_association: 'NONE' }], { marker, label: 'state', trustedLogin: 'owner' }), /untrusted state marker/);
});

test('controller run provenance is bound to repository, dispatch workflow and trusted ref', () => {
  const run = { id: 11, event: 'workflow_dispatch', path: '.github/workflows/delivery-v2-dispatch.yml', head_branch: 'main', repository: { full_name: 'owner/orchestrator' } };
  assert.equal(validateControllerRunProvenance(run, { orchestratorRepository: 'owner/orchestrator', trustedRef: 'main' }).runId, 11);
  assert.throws(() => validateControllerRunProvenance({ ...run, head_branch: 'feature' }, { orchestratorRepository: 'owner/orchestrator', trustedRef: 'main' }), /trusted ref mismatch/);
  assert.throws(() => validateControllerRunProvenance({ ...run, path: '.github/workflows/other.yml' }, { orchestratorRepository: 'owner/orchestrator', trustedRef: 'main' }), /workflow path mismatch/);
});
