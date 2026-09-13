#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildClassifierPackage } from '../src/v2/classifier-distribution.mjs';
import { validateControllerTargetPolicies } from '../src/v2/controller-target-policy.mjs';

const rootDir = process.cwd();
const configDir = resolve(rootDir, 'config/delivery-v2-targets');
const files = readdirSync(configDir).filter((name) => name.endsWith('.json')).sort();
const errors = [];
const seenRepositories = new Set();
const sourceCommit = '0000000000000000000000000000000000000000';

for (const name of files) {
  try {
    const config = JSON.parse(readFileSync(resolve(configDir, name), 'utf8'));
    const bundle = buildClassifierPackage({ rootDir, sourceCommit, targetConfig: config });
    if (seenRepositories.has(bundle.target.repository)) {
      errors.push(`${name}: duplicate repository ${bundle.target.repository}`);
    }
    seenRepositories.add(bundle.target.repository);
  } catch (error) {
    errors.push(`${name}: ${error.message}`);
  }
}

try {
  const controllerConfig = JSON.parse(readFileSync(resolve(rootDir, 'config/delivery-v2-controller-targets.json'), 'utf8'));
  const controllerTargets = validateControllerTargetPolicies(controllerConfig);
  for (const repository of Object.keys(controllerTargets)) {
    if (!seenRepositories.has(repository) && repository !== 'crgasparoto-br/delivery-orchestrator') {
      errors.push(`controller target ${repository} has no classifier target policy`);
    }
  }
} catch (error) {
  errors.push(`delivery-v2-controller-targets.json: ${error.message}`);
}

if (files.length === 0) errors.push('no Delivery V2 target configs found');
if (errors.length) {
  console.error('Delivery V2 target policies: INVALID');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Delivery V2 target policies: VALID (${files.length})`);
  for (const repository of [...seenRepositories].sort()) console.log(`- ${repository}`);
}
