import { STATES } from './constants.mjs';
import { resolveReusablePullRequest } from './pull-request-binding.mjs';
import { publishIndependentAuditReleaseSignal } from './pr-release-signal.mjs';
import { transition } from './state-machine.mjs';

function failReleaseSignal(state, signal) {
  const withSignal = { ...state, release_signal: signal };
  return transition(withSignal, STATES.FAILED, {
    reason: `independent audit release signal failed: ${signal.reason}`,
    release_signal_reason: signal.reason
  });
}

export async function finalizeIndependentRelease({ state, config, fetchImpl = fetch }) {
  if (state.status !== STATES.COMPLETE) return state;

  let binding;
  try {
    binding = await resolveReusablePullRequest({
      repository: config.repository,
      issueNumber: config.issueNumber,
      token: config.writeToken || config.readToken,
      fetchImpl
    });
  } catch (error) {
    return failReleaseSignal(state, {
      published: false,
      reason: 'pull-request-resolution-error',
      error: error.message
    });
  }

  if (binding.status === 'ambiguous') {
    return failReleaseSignal(state, {
      published: false,
      reason: 'release-pr-ambiguous',
      candidates: binding.candidates.map((candidate) => candidate.number)
    });
  }
  if (binding.status !== 'bound' || !binding.pullRequest) {
    return failReleaseSignal(state, { published: false, reason: 'release-pr-not-found' });
  }

  const resolvedPr = binding.pullRequest;
  if (state.bound_pull_request && Number(state.bound_pull_request) !== Number(resolvedPr.number)) {
    return failReleaseSignal(state, {
      published: false,
      reason: 'bound-pr-changed',
      expected_pull_request: Number(state.bound_pull_request),
      observed_pull_request: Number(resolvedPr.number)
    });
  }

  const currentState = {
    ...state,
    bound_pull_request: Number(resolvedPr.number),
    bound_head_ref: resolvedPr.head?.ref ?? state.bound_head_ref ?? null,
    bound_head_sha: resolvedPr.head?.sha ?? null
  };

  let signal;
  try {
    signal = await publishIndependentAuditReleaseSignal({
      repository: config.repository,
      pullRequestNumber: currentState.bound_pull_request,
      expectedHeadSha: currentState.handoff_head_sha,
      materialHeadSha: currentState.material_head_sha,
      audit: currentState.last_audit,
      token: config.writeToken,
      fetchImpl
    });
  } catch (error) {
    signal = {
      published: false,
      reason: 'release-signal-publication-error',
      error: error.message
    };
  }

  if (!signal.published) return failReleaseSignal(currentState, signal);
  return { ...currentState, release_signal: signal };
}
