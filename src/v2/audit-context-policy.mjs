import { extname, posix as pathPosix } from 'node:path';

export const AUDIT_RESERVED_SEMANTIC_CATEGORIES = Object.freeze([
  'executable',
  'tests',
  'contract',
  'config',
  'evidence',
  'canonical-docs',
  'prompts'
]);
export const AUDIT_SEMANTIC_CATEGORY_ORDER = Object.freeze([
  ...AUDIT_RESERVED_SEMANTIC_CATEGORIES,
  'docs',
  'other'
]);
export const AUDIT_CONTRACT_TEXT_EXTENSIONS = Object.freeze([
  '.avdl', '.avpr', '.avsc', '.graphql', '.graphqls', '.gql', '.prisma', '.proto', '.raml', '.thrift', '.wsdl', '.xsd'
]);

const CONTRACT_TEXT_EXTENSION_SET = new Set(AUDIT_CONTRACT_TEXT_EXTENSIONS);
const GENERATED_LOW_VALUE_PATTERNS = Object.freeze([
  /(?:^|\/)\.audit(?:\/|$)/,
  /(?:^|\/)skills\/catalog(?:\/|$)/,
  /(?:^|\/)\.generated(?:\/|$)/,
  /\.lock\.ya?ml$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)\.github\/aw\/actions-lock\.json$/
]);
const WORKER_PROMPT_PATTERN = /^\.github\/workflows\/delivery-v2-worker-(?:claude|codex|copilot)-(?:fast|standard|critical)\.md$/;
const CANONICAL_DOC_PATTERN = /^docs\/delivery-v2\/(?:MASTER_SPEC|AUDIT_CONTRACT|ROADMAP)\.md$/;
const TEST_DIRECTORY_PATTERN = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/;
const TEST_FILE_PATTERN = /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/;
const CONTRACT_PATH_PATTERNS = Object.freeze([
  /^(?:contracts?|schemas?|idl|protos?|openapi|asyncapi|api[-_](?:contracts?|specs?))(?:\/|$)/i,
  /(?:^|\/)(?:openapi|swagger|asyncapi)(?:\.[^/]+)?$/i,
  /(?:^|\/)(?:schema|contract)\.(?:graphqls?|gql|json|prisma|sql|toml|xml|ya?ml)$/i,
  /(?:^|\/)[^/]+\.(?:schema|contract)\.(?:json|toml|xml|ya?ml)$/i
]);
const CONFIG_PATH_PATTERNS = Object.freeze([
  /^config(?:\/|$)/,
  /^\.delivery-v2(?:\/|$)/,
  /^\.github\/workflows(?:\/|$)/,
  /(?:^|\/)(?:package|tsconfig|jsconfig)\.json$/,
  /(?:^|\/)[^/]+\.config\.(?:cjs|js|json|mjs|ts|yaml|yml|toml)$/,
  /(?:^|\/)(?:action|docker-compose)\.ya?ml$/,
  /(?:^|\/)(?:Dockerfile|Makefile|Procfile)$/
]);
const EXECUTABLE_ROOT_PATTERN = /^(?:src|scripts|actions|apps|packages|services|lib|bin|server|client|web|api)(?:\/|$)/;
const EXECUTABLE_EXTENSIONS = new Set([
  '.cjs', '.cs', '.css', '.go', '.html', '.java', '.js', '.jsx', '.kt', '.kts',
  '.less', '.mjs', '.php', '.py', '.rb', '.rs', '.sass', '.scala', '.scss', '.sh',
  '.sql', '.svelte', '.swift', '.ts', '.tsx', '.vue'
]);

export function normalizeAuditSemanticPath(filePath) {
  const normalized = pathPosix.normalize(String(filePath ?? '').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  return normalized;
}

export function isGeneratedLowValueAuditPath(filePath) {
  const value = normalizeAuditSemanticPath(filePath);
  return Boolean(value && GENERATED_LOW_VALUE_PATTERNS.some((pattern) => pattern.test(value)));
}

export function isActiveWorkerPromptAuditPath(filePath) {
  const value = normalizeAuditSemanticPath(filePath);
  return Boolean(value && WORKER_PROMPT_PATTERN.test(value));
}

export function isCanonicalDeliveryV2DocAuditPath(filePath) {
  const value = normalizeAuditSemanticPath(filePath);
  return Boolean(value && CANONICAL_DOC_PATTERN.test(value));
}

function isSharedContractNormalized(value) {
  return CONTRACT_TEXT_EXTENSION_SET.has(extname(value).toLowerCase()) || CONTRACT_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

export function isSharedContractAuditPath(filePath) {
  const value = normalizeAuditSemanticPath(filePath);
  return Boolean(value && isSharedContractNormalized(value));
}

export function auditSemanticCategory(filePath) {
  const value = normalizeAuditSemanticPath(filePath);
  if (!value) return 'other';
  if (TEST_DIRECTORY_PATTERN.test(value) || TEST_FILE_PATTERN.test(value)) return 'tests';
  if (/^docs\/delivery-v2\/evidence\//.test(value)) return 'evidence';
  if (CANONICAL_DOC_PATTERN.test(value)) return 'canonical-docs';
  if (WORKER_PROMPT_PATTERN.test(value)) return 'prompts';
  if (isSharedContractNormalized(value)) return 'contract';
  if (CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(value))) return 'config';
  if (/^(?:docs)(?:\/|$)/.test(value) || /(?:^|\/)README(?:\.[^/]*)?$/i.test(value)) return 'docs';
  if (EXECUTABLE_EXTENSIONS.has(extname(value).toLowerCase()) || EXECUTABLE_ROOT_PATTERN.test(value) || /^\.github\/scripts(?:\/|$)/.test(value)) return 'executable';
  return 'other';
}
