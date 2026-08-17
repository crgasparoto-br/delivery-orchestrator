const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUEST_TITLE_PREFIX = 'delivery-request:';

function parseInteger(value, name, { min = 1, max }) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || (max !== undefined && number > max)) {
    const upper = max === undefined ? '' : ` and <= ${max}`;
    throw new Error(`${name} must be >= ${min}${upper}`);
  }
  return number;
}

function parseAllowlist(value, fallback) {
  const entries = String(value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

function repositoryAllowed(repository, patterns) {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('/*')) return repository.startsWith(`${pattern.slice(0, -1)}`);
    return pattern === repository;
  });
}

function validateRepository(repository) {
  const value = String(repository ?? '').trim();
  if (!REPOSITORY_PATTERN.test(value)) {
    throw new Error('target_repository must use owner/repo format');
  }
  return value;
}

function parseControlIssueBody(body) {
  let payload;
  try {
    payload = JSON.parse(String(body ?? ''));
  } catch {
    throw new Error('delivery request issue body must be a JSON object');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('delivery request issue body must be a JSON object');
  }
  const allowedKeys = new Set(['target_repository', 'issue_number', 'max_cycles']);
  const unknown = Object.keys(payload).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported delivery request fields: ${unknown.sort().join(', ')}`);
  }
  return payload;
}

export function normalizeDeliveryRequest({
  eventName,
  event,
  manualInputs = {},
  repositoryOwner,
  allowedActorsText = '',
  allowedRepositoriesText = '',
  issueMaxCycles = 12
}) {
  if (eventName === 'workflow_dispatch') {
    return {
      source: 'workflow_dispatch',
      targetRepository: validateRepository(manualInputs.targetRepository),
      issueNumber: parseInteger(manualInputs.issueNumber, 'issue_number', { min: 1 }),
      maxCycles: parseInteger(manualInputs.maxCycles || 6, 'max_cycles', { min: 1, max: 100 }),
      controlIssueNumber: null
    };
  }

  if (eventName !== 'issues' || event?.action !== 'opened') {
    throw new Error(`unsupported delivery request event: ${eventName || 'unknown'}`);
  }

  const controlIssue = event.issue;
  if (!controlIssue || !String(controlIssue.title ?? '').startsWith(REQUEST_TITLE_PREFIX)) {
    throw new Error(`control issue title must start with ${REQUEST_TITLE_PREFIX}`);
  }

  const actor = event.sender?.login ?? controlIssue.user?.login ?? '';
  const allowedActors = parseAllowlist(allowedActorsText, [repositoryOwner].filter(Boolean));
  if (!actor || !allowedActors.includes(actor)) {
    throw new Error(`actor ${actor || '<unknown>'} is not allowed to request deliveries`);
  }

  const payload = parseControlIssueBody(controlIssue.body);
  const targetRepository = validateRepository(payload.target_repository);
  const allowedRepositories = parseAllowlist(
    allowedRepositoriesText,
    repositoryOwner ? [`${repositoryOwner}/*`] : []
  );
  if (allowedRepositories.length === 0 || !repositoryAllowed(targetRepository, allowedRepositories)) {
    throw new Error(`target repository ${targetRepository} is not allowed`);
  }

  const requestCycleLimit = parseInteger(issueMaxCycles, 'DELIVERY_REQUEST_MAX_CYCLES', { min: 1, max: 100 });
  return {
    source: 'control_issue',
    targetRepository,
    issueNumber: parseInteger(payload.issue_number, 'issue_number', { min: 1 }),
    maxCycles: parseInteger(payload.max_cycles || 6, 'max_cycles', { min: 1, max: requestCycleLimit }),
    controlIssueNumber: parseInteger(controlIssue.number, 'control_issue_number', { min: 1 })
  };
}
