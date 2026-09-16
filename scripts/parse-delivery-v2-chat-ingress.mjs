#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ALLOWED_BASES = new Set(['main', 'develop']);
const ALLOWED_RISKS = new Set(['auto', 'fast', 'standard', 'critical']);
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function positiveInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function splitPaths(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return [...new Set(String(value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function parseChatIngressPayload(body) {
  let value;
  try {
    value = JSON.parse(String(body ?? ''));
  } catch {
    throw new Error('chat ingress body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chat ingress body must be a JSON object');

  const repository = String(value.target_repository ?? '').trim();
  if (!REPOSITORY_RE.test(repository)) throw new Error('target_repository must use owner/repo form');
  if (!repository.startsWith('crgasparoto-br/')) throw new Error('target_repository is outside the allowed owner');

  const issue = positiveInteger(value.target_issue, 'target_issue');
  const baseBranch = String(value.base_branch ?? 'main').trim();
  if (!ALLOWED_BASES.has(baseBranch)) throw new Error('base_branch must be main or develop');

  const riskProfile = String(value.risk_profile ?? 'auto').trim().toLowerCase();
  if (!ALLOWED_RISKS.has(riskProfile)) throw new Error('risk_profile must be auto, fast, standard or critical');

  const changedPaths = splitPaths(value.changed_paths);
  return Object.freeze({
    target_repository: repository,
    target_issue: String(issue),
    base_branch: baseBranch,
    risk_profile: riskProfile,
    changed_paths: changedPaths.join('\n')
  });
}

async function writeOutput(payload) {
  const output = String(process.env.GITHUB_OUTPUT ?? '').trim();
  if (!output) return;
  const lines = Object.entries(payload).map(([key, value]) => {
    const delimiter = `DV2_${key.toUpperCase()}_${Date.now()}`;
    return `${key}<<${delimiter}\n${value}\n${delimiter}`;
  });
  await appendFile(output, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const payload = parseChatIngressPayload(process.env.DELIVERY_V2_CHAT_INGRESS_BODY);
  await writeOutput(payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
