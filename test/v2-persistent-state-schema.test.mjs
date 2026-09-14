import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPersistentDeliveryState } from '../src/v2/persistent-state.mjs';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SCHEMA_URL = new URL('../schemas/delivery-v2-persistent-state.schema.json', import.meta.url);

function valueMatchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateSchemaValue(schema, value, path = '$') {
  const errors = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => valueMatchesType(value, type))) {
    return [`${path}: expected ${allowedTypes.join('|')}`];
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path}: const mismatch`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum mismatch`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: minLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
  }
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) errors.push(`${path}: minimum`);
  if (Array.isArray(value)) {
    if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
      errors.push(`${path}: uniqueItems`);
    }
    if (schema.items) value.forEach((entry, index) => errors.push(...validateSchemaValue(schema.items, entry, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validateSchemaValue(child, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

async function persistentStateSchema() {
  return JSON.parse(await readFile(SCHEMA_URL, 'utf8'));
}

function runtimeState() {
  return createPersistentDeliveryState({
    repository: 'acme/example',
    issueNumber: 76,
    pullRequestNumber: 77,
    baseRef: 'main',
    baseSha: BASE,
    headRef: 'feat/example',
    materialHeadSha: SHA,
    effectiveRisk: 'critical',
    classifier: { subjectSha: SHA, version: 'v2', fingerprint: 'classifier-fp', current: true },
    provider: 'codex',
    model: 'gpt-5.4',
    auditorProvider: 'claude',
    auditorModel: 'claude-opus-5',
    status: 'ci-pending',
    attempts: { implementation: 1, audit: 0, auditRemediation: 0 },
    workflowChecks: [],
    blockingFindings: [],
    evidenceRefs: ['github:pr/77'],
    lastReason: 'awaiting-ci'
  });
}

test('runtime-produced persistent state conforms to the canonical JSON schema contract', async () => {
  const schema = await persistentStateSchema();
  assert.deepEqual(validateSchemaValue(schema, runtimeState()), []);
});

test('persistent state schema remains fail-closed for undeclared fields and invalid AI identity types', async () => {
  const schema = await persistentStateSchema();
  const state = runtimeState();
  const unknownFieldErrors = validateSchemaValue(schema, { ...state, shadowModel: 'unexpected' });
  const invalidModelErrors = validateSchemaValue(schema, { ...state, model: 42 });

  assert.ok(unknownFieldErrors.some((error) => error.includes('shadowModel: unexpected property')));
  assert.ok(invalidModelErrors.some((error) => error.includes('model: expected string|null')));
});
