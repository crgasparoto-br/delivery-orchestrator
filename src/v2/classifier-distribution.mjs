import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeRepositoryRiskPolicy } from './repository-risk-policy.mjs';

export const CLASSIFIER_PACKAGE_SCHEMA_VERSION = 1;
export const TARGET_POLICY_SCHEMA_VERSION = 1;
export const CLASSIFIER_SOURCE_REPOSITORY = 'crgasparoto-br/delivery-orchestrator';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function validateTargetConfig(targetConfig) {
  if (!targetConfig || typeof targetConfig !== 'object' || Array.isArray(targetConfig)) {
    throw new Error('target config must be an object');
  }
  const allowed = new Set(['schemaVersion', 'repository', 'baseBranch', 'packageDir', 'riskPolicy']);
  for (const key of Object.keys(targetConfig)) {
    if (!allowed.has(key)) throw new Error(`unsupported target config field: ${key}`);
  }
  if (targetConfig.schemaVersion !== TARGET_POLICY_SCHEMA_VERSION) {
    throw new Error(`target config schemaVersion must be ${TARGET_POLICY_SCHEMA_VERSION}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(targetConfig.repository || ''))) {
    throw new Error('target config repository must use owner/name');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(String(targetConfig.baseBranch || ''))) {
    throw new Error('target config baseBranch is required');
  }
  const packageDir = String(targetConfig.packageDir || '.delivery-v2').replace(/\/+$/, '');
  if (!packageDir || packageDir.startsWith('/') || packageDir.split('/').includes('..')) {
    throw new Error('target config packageDir must stay inside the repository');
  }
  return {
    schemaVersion: TARGET_POLICY_SCHEMA_VERSION,
    repository: targetConfig.repository,
    baseBranch: targetConfig.baseBranch,
    packageDir,
    riskPolicy: normalizeRepositoryRiskPolicy(targetConfig.riskPolicy || {})
  };
}

function verifierSource() {
  return `#!/usr/bin/env node\nimport { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\nimport { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nconst root = dirname(fileURLToPath(import.meta.url));\nconst lock = JSON.parse(readFileSync(resolve(root, 'lock.json'), 'utf8'));\nconst sha256 = (value) => createHash('sha256').update(value).digest('hex');\nconst stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;\nconst stableJson = (value) => JSON.stringify(stable(value), null, 2) + '\\n';\n\nconst errors = [];\nfor (const [path, expected] of Object.entries(lock.files || {})) {\n  const actual = sha256(readFileSync(resolve(root, path), 'utf8'));\n  if (actual !== expected) errors.push(path + ': expected ' + expected + ', got ' + actual);\n}\nconst packageIdentity = {\n  schemaVersion: lock.schemaVersion,\n  source: lock.source,\n  canonicalClassifierFingerprint: lock.canonicalClassifierFingerprint,\n  target: lock.target,\n  files: lock.files\n};\nconst fingerprint = sha256(stableJson(packageIdentity));\nif (fingerprint !== lock.packageFingerprint) errors.push('packageFingerprint mismatch');\nif (errors.length) {\n  console.error('Delivery V2 classifier package drift detected');\n  for (const error of errors) console.error('- ' + error);\n  process.exitCode = 1;\n} else {\n  console.log('Delivery V2 classifier package: VALID');\n  console.log('Source: ' + lock.source.repository + '@' + lock.source.commit);\n  console.log('Fingerprint: ' + lock.packageFingerprint);\n}\n`;
}

export function buildClassifierPackage({ rootDir = process.cwd(), sourceCommit, targetConfig }) {
  if (!/^[0-9a-f]{40}$/i.test(String(sourceCommit || ''))) {
    throw new Error('sourceCommit must be an exact 40-character Git SHA');
  }
  const target = validateTargetConfig(targetConfig);
  const runtime = {
    'repository-risk-policy.mjs': readFileSync(resolve(rootDir, 'src/v2/repository-risk-policy.mjs'), 'utf8'),
    'risk-profile.mjs': readFileSync(resolve(rootDir, 'src/v2/risk-profile.mjs'), 'utf8')
  };
  const policyDocument = {
    schemaVersion: TARGET_POLICY_SCHEMA_VERSION,
    sourceRepository: CLASSIFIER_SOURCE_REPOSITORY,
    repository: target.repository,
    riskPolicy: target.riskPolicy
  };
  const files = {
    ...runtime,
    'policy.json': stableJson(policyDocument),
    'verify.mjs': verifierSource()
  };
  const fileHashes = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)]));
  const canonicalClassifierFingerprint = sha256(stableJson({
    schemaVersion: CLASSIFIER_PACKAGE_SCHEMA_VERSION,
    runtime: {
      'repository-risk-policy.mjs': fileHashes['repository-risk-policy.mjs'],
      'risk-profile.mjs': fileHashes['risk-profile.mjs']
    }
  }));
  const packageIdentity = {
    schemaVersion: CLASSIFIER_PACKAGE_SCHEMA_VERSION,
    source: { repository: CLASSIFIER_SOURCE_REPOSITORY, commit: String(sourceCommit).toLowerCase() },
    canonicalClassifierFingerprint,
    target: {
      repository: target.repository,
      baseBranch: target.baseBranch,
      packageDir: target.packageDir,
      policySchemaVersion: TARGET_POLICY_SCHEMA_VERSION
    },
    files: fileHashes
  };
  const lock = {
    contract: 'delivery-v2-classifier-package',
    ...packageIdentity,
    packageFingerprint: sha256(stableJson(packageIdentity)),
    verificationCommand: `node ${target.packageDir}/verify.mjs`
  };
  return {
    target,
    files: { ...files, 'lock.json': stableJson(lock) },
    lock
  };
}
