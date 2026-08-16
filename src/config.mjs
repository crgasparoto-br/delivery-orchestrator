import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export function resolveSandboxMode(value) {
  const resolved = value || 'workspace-write';
  if (!SANDBOX_MODES.has(resolved)) {
    throw new Error(`CODEX_SANDBOX_MODE must be one of: ${[...SANDBOX_MODES].join(', ')}`);
  }
  return resolved;
}

function int(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(args = {}) {
  const repository = args.repository ?? process.env.TARGET_REPOSITORY;
  const issueNumber = Number.parseInt(args.issueNumber ?? process.env.TARGET_ISSUE ?? '', 10);
  if (!repository || !repository.includes('/')) throw new Error('TARGET_REPOSITORY must be owner/repo');
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('TARGET_ISSUE must be a positive integer');
  return {
    repository,
    issueNumber,
    maxCycles: int('MAX_CYCLES', 6),
    maxStagnantCycles: int('MAX_STAGNANT_CYCLES', 1),
    model: process.env.OPENAI_MODEL ?? 'gpt-5.6-sol',
    sandboxMode: resolveSandboxMode(process.env.CODEX_SANDBOX_MODE),
    openaiApiKey: process.env.OPENAI_API_KEY,
    writeToken: process.env.DELIVERY_GITHUB_WRITE_TOKEN,
    readToken: process.env.DELIVERY_GITHUB_READ_TOKEN,
    auditorPrivateKeyB64: process.env.AUDITOR_PRIVATE_KEY_B64 ?? '',
    auditorKeyPassword: process.env.AUDITOR_KEY_PASSWORD ?? '',
    auditorKeyId: process.env.AUDITOR_KEY_ID ?? '',
    trustedAuditorsPath: process.env.TRUSTED_AUDITORS_PATH ?? '',
    runsRoot: process.env.RUNS_ROOT ? path.resolve(process.env.RUNS_ROOT) : path.join(ROOT, 'runs'),
    skillCatalog: process.env.SKILL_CATALOG ? path.resolve(process.env.SKILL_CATALOG) : path.join(ROOT, 'skills', 'catalog'),
    implementerPrompt: path.join(ROOT, 'prompts', 'implementer.md'),
    auditorPrompt: path.join(ROOT, 'prompts', 'auditor.md')
  };
}
