#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MANIFEST = 'config/delivery-v2-requirements.json';
export const ALLOWED_STATUSES = new Set(['planned', 'implemented', 'validated', 'rolled-out']);
export const COMPLETION_STATUSES = new Set(['validated', 'rolled-out']);
const STATUS_RANK = Object.freeze({ planned: 0, implemented: 1, validated: 2, 'rolled-out': 3 });

function extractRequirementIds(text) {
  return new Set(text.match(/\bDV2-\d{3}\b/g) ?? []);
}

function fileRefToPath(ref) {
  return typeof ref === 'string' && ref.startsWith('file:') ? ref.slice(5) : null;
}

function validateLocalRefs(refs, rootDir, requirementId, field, errors) {
  for (const ref of refs ?? []) {
    const localPath = fileRefToPath(ref);
    if (!localPath) continue;
    if (!existsSync(resolve(rootDir, localPath))) {
      errors.push(`${requirementId}.${field}: missing local evidence ${localPath}`);
    }
  }
}

function minimumCompletionStatus(item) {
  return item.minimumCompletionStatus ?? 'validated';
}

export function validateDeliveryV2Contract({ manifest, rootDir, masterSpecText, roadmapText }) {
  const errors = [];
  const warnings = [];

  if (manifest?.schemaVersion !== 1) errors.push('manifest.schemaVersion must be 1');
  if (manifest?.contract !== 'delivery-v2') errors.push('manifest.contract must be delivery-v2');
  if (!Array.isArray(manifest?.requirements) || manifest.requirements.length === 0) {
    errors.push('manifest.requirements must be a non-empty array');
  }

  const requirements = Array.isArray(manifest?.requirements) ? manifest.requirements : [];
  const ids = requirements.map((item) => item?.id);
  const uniqueIds = new Set(ids);

  if (uniqueIds.size !== ids.length) errors.push('requirement IDs must be unique');

  for (const item of requirements) {
    if (!/^DV2-\d{3}$/.test(item?.id ?? '')) {
      errors.push(`invalid requirement id: ${item?.id ?? '<missing>'}`);
      continue;
    }

    if (!ALLOWED_STATUSES.has(item.status)) {
      errors.push(`${item.id}: unsupported status ${item.status}`);
    }
    const minimum = minimumCompletionStatus(item);
    if (!COMPLETION_STATUSES.has(minimum)) {
      errors.push(`${item.id}: unsupported minimumCompletionStatus ${minimum}`);
    }
    if (typeof item.requiredForV2Default !== 'boolean') {
      errors.push(`${item.id}: requiredForV2Default must be boolean`);
    }
    if (item.trackingIssue !== manifest.umbrellaIssue) {
      errors.push(`${item.id}: trackingIssue must equal umbrellaIssue ${manifest.umbrellaIssue}`);
    }

    const implementationRefs = item.implementationRefs ?? [];
    const validationRefs = item.validationRefs ?? [];
    const rolloutRefs = item.rolloutRefs ?? [];

    if (!Array.isArray(implementationRefs) || !Array.isArray(validationRefs) || !Array.isArray(rolloutRefs)) {
      errors.push(`${item.id}: implementationRefs, validationRefs and rolloutRefs must be arrays`);
      continue;
    }

    if (['implemented', 'validated', 'rolled-out'].includes(item.status) && implementationRefs.length === 0) {
      errors.push(`${item.id}: ${item.status} requires implementationRefs`);
    }
    if (['validated', 'rolled-out'].includes(item.status) && validationRefs.length === 0) {
      errors.push(`${item.id}: ${item.status} requires validationRefs`);
    }
    if (item.status === 'rolled-out' && rolloutRefs.length === 0) {
      errors.push(`${item.id}: rolled-out requires rolloutRefs`);
    }

    validateLocalRefs(implementationRefs, rootDir, item.id, 'implementationRefs', errors);
    validateLocalRefs(validationRefs, rootDir, item.id, 'validationRefs', errors);
    validateLocalRefs(rolloutRefs, rootDir, item.id, 'rolloutRefs', errors);
  }

  const manifestIds = new Set(ids.filter((id) => typeof id === 'string'));
  const masterIds = extractRequirementIds(masterSpecText);
  const roadmapIds = extractRequirementIds(roadmapText);

  for (const id of manifestIds) {
    if (!masterIds.has(id)) errors.push(`${id}: missing from canonical master specification`);
    if (!roadmapIds.has(id)) errors.push(`${id}: missing from roadmap`);
  }

  for (const id of masterIds) {
    if (!manifestIds.has(id)) errors.push(`${id}: master specification contains unknown requirement id`);
  }
  for (const id of roadmapIds) {
    if (!manifestIds.has(id)) errors.push(`${id}: roadmap contains unknown requirement id`);
  }

  const counts = Object.fromEntries([...ALLOWED_STATUSES].map((status) => [status, 0]));
  for (const item of requirements) {
    if (ALLOWED_STATUSES.has(item.status)) counts[item.status] += 1;
  }

  const terminalStatuses = new Set(manifest?.completionPolicy?.terminalStatuses ?? []);
  const incompleteRequired = requirements
    .filter((item) => {
      if (!item.requiredForV2Default) return false;
      const minimum = minimumCompletionStatus(item);
      return !terminalStatuses.has(item.status) || (STATUS_RANK[item.status] ?? -1) < (STATUS_RANK[minimum] ?? Number.POSITIVE_INFINITY);
    })
    .map((item) => item.id);

  if (!manifest?.completionPolicy?.allRequiredRequirementsMustBeTerminal) {
    warnings.push('completionPolicy.allRequiredRequirementsMustBeTerminal is not enabled');
  }

  const retirementId = manifest?.completionPolicy?.v1RetirementRequirement;
  if (retirementId && !manifestIds.has(retirementId)) {
    errors.push(`completionPolicy.v1RetirementRequirement references unknown id ${retirementId}`);
  }

  return {
    ok: errors.length === 0,
    complete: errors.length === 0 && incompleteRequired.length === 0,
    errors,
    warnings,
    counts,
    total: requirements.length,
    incompleteRequired
  };
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    requireComplete: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--manifest') {
      args.manifest = argv[++index];
    } else if (token === '--require-complete') {
      args.requireComplete = true;
    } else if (token === '--json') {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

export function runDeliveryV2Verification({
  rootDir = process.cwd(),
  manifestPath = DEFAULT_MANIFEST,
  requireComplete = false
} = {}) {
  const absoluteManifestPath = resolve(rootDir, manifestPath);
  const manifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8'));

  const masterSpecPath = resolve(rootDir, manifest.canonicalSpec);
  const roadmapPath = resolve(rootDir, manifest.roadmap);

  if (!existsSync(masterSpecPath)) {
    return {
      ok: false,
      complete: false,
      errors: [`missing canonical spec: ${manifest.canonicalSpec}`],
      warnings: [],
      counts: {},
      total: 0,
      incompleteRequired: []
    };
  }
  if (!existsSync(roadmapPath)) {
    return {
      ok: false,
      complete: false,
      errors: [`missing roadmap: ${manifest.roadmap}`],
      warnings: [],
      counts: {},
      total: 0,
      incompleteRequired: []
    };
  }

  const result = validateDeliveryV2Contract({
    manifest,
    rootDir,
    masterSpecText: readFileSync(masterSpecPath, 'utf8'),
    roadmapText: readFileSync(roadmapPath, 'utf8')
  });

  if (requireComplete && result.ok && !result.complete) {
    result.errors.push(
      `Delivery V2 is not complete; non-terminal required requirements: ${result.incompleteRequired.join(', ')}`
    );
    result.ok = false;
  }

  return result;
}

function printHuman(result) {
  const countText = Object.entries(result.counts ?? {})
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');

  console.log(`Delivery V2 contract: ${result.ok ? 'VALID' : 'INVALID'}`);
  if (countText) console.log(`Requirements: total=${result.total} ${countText}`);
  console.log(`Default-ready: ${result.complete ? 'YES' : 'NO'}`);

  if (result.incompleteRequired?.length) {
    console.log(`Pending required: ${result.incompleteRequired.join(', ')}`);
  }
  for (const warning of result.warnings ?? []) console.log(`warning: ${warning}`);
  for (const error of result.errors ?? []) console.error(`error: ${error}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runDeliveryV2Verification({
    rootDir: process.cwd(),
    manifestPath: args.manifest,
    requireComplete: args.requireComplete
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentPath = resolve(fileURLToPath(import.meta.url));
if (invokedPath === currentPath) main();
