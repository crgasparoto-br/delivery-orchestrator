import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseChatIngressPayload } from '../scripts/parse-delivery-v2-chat-ingress.mjs';

test('chat ingress normalizes a configured delivery request', () => {
  const payload = parseChatIngressPayload(JSON.stringify({
    target_repository: 'crgasparoto-br/training-system',
    target_issue: 447,
    base_branch: 'develop',
    risk_profile: 'auto',
    changed_paths: ['apps/api/src/services/aluno.service.ts', 'apps/api/src/services/aluno.service.ts']
  }));

  assert.deepEqual(payload, {
    target_repository: 'crgasparoto-br/training-system',
    target_issue: '447',
    base_branch: 'develop',
    risk_profile: 'auto',
    changed_paths: 'apps/api/src/services/aluno.service.ts'
  });
});

test('chat ingress fails closed for malformed or out-of-scope targets', () => {
  assert.throws(() => parseChatIngressPayload('not-json'), /valid JSON/);
  assert.throws(() => parseChatIngressPayload(JSON.stringify({ target_repository: 'other/repo', target_issue: 1 })), /outside the allowed owner/);
  assert.throws(() => parseChatIngressPayload(JSON.stringify({ target_repository: 'crgasparoto-br/training-system', target_issue: 0 })), /positive integer/);
  assert.throws(() => parseChatIngressPayload(JSON.stringify({ target_repository: 'crgasparoto-br/training-system', target_issue: 447, base_branch: 'feature' })), /main or develop/);
});

test('chat ingress workflow delegates to the durable V2 dispatch and never implements directly', async () => {
  const source = await readFile(new URL('../.github/workflows/delivery-v2-chat-ingress.yml', import.meta.url), 'utf8');
  assert.match(source, /gh workflow run delivery-v2-dispatch\.yml/);
  assert.match(source, /delivery-v2-dispatch/);
  assert.doesNotMatch(source, /run-delivery-v2-controller\.mjs/);
  assert.doesNotMatch(source, /delivery-v2-worker-/);
});
