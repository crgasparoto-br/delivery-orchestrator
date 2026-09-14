const MERGE_ENFORCEMENT_MODES = new Set(['native-required-status', 'controller-status-only']);

function requiredObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

export function normalizeControllerTargetPolicy(repository, target, { baseBranch } = {}) {
  const value = requiredObject(target, `controller target ${repository}`);
  const configuredBase = requiredString(value.baseBranch, `${repository}.baseBranch`);
  if (baseBranch && configuredBase !== baseBranch) throw new Error(`base branch ${baseBranch} does not match configured ${configuredBase}`);
  const finalStatusName = requiredString(value.finalStatusName, `${repository}.finalStatusName`);
  const mergePolicy = requiredObject(value.mergePolicy, `${repository}.mergePolicy`);
  const requiredFinalStatusName = requiredString(mergePolicy.requiredFinalStatusName, `${repository}.mergePolicy.requiredFinalStatusName`);
  if (requiredFinalStatusName !== finalStatusName) throw new Error(`${repository}: merge policy final status must match finalStatusName`);
  const enforcementMode = requiredString(mergePolicy.enforcementMode, `${repository}.mergePolicy.enforcementMode`);
  if (!MERGE_ENFORCEMENT_MODES.has(enforcementMode)) throw new Error(`${repository}: unsupported merge enforcement mode ${enforcementMode}`);
  const nativeRequiredStatusEnforced = mergePolicy.nativeRequiredStatusEnforced === true;
  const limitation = String(mergePolicy.limitation ?? '').trim();
  if (enforcementMode === 'native-required-status' && !nativeRequiredStatusEnforced) {
    throw new Error(`${repository}: native-required-status requires nativeRequiredStatusEnforced=true`);
  }
  if (enforcementMode === 'controller-status-only' && nativeRequiredStatusEnforced) {
    throw new Error(`${repository}: controller-status-only cannot claim native required-status enforcement`);
  }
  if (enforcementMode === 'controller-status-only' && !limitation) {
    throw new Error(`${repository}: controller-status-only requires an explicit enforcement limitation`);
  }
  return Object.freeze({
    ...value,
    mergePolicy: Object.freeze({
      requiredFinalStatusName,
      enforcementMode,
      nativeRequiredStatusEnforced,
      limitation: limitation || null
    })
  });
}

export function validateControllerTargetPolicies(config) {
  const source = requiredObject(config, 'controller target config');
  const targets = requiredObject(source.targets, 'controller target config.targets');
  const normalized = {};
  for (const [repository, target] of Object.entries(targets)) {
    normalized[repository] = normalizeControllerTargetPolicy(repository, target);
  }
  if (Object.keys(normalized).length === 0) throw new Error('at least one controller target is required');
  return Object.freeze(normalized);
}
