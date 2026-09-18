#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::Delivery V2 sandbox preflight failed: $*" >&2
  exit 127
}

require_tool() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not available inside the effective agent sandbox PATH"
}

echo "== Delivery V2 effective sandbox toolchain =="

# gh-aw materializes MCP-backed CLIs under RUNNER_TEMP before entering awf.
# Rebuild that compiler-owned PATH entry here so Codex and its child shells
# inherit safeoutputs even if the outer sandbox command loses the host PATH.
if [ -n "${RUNNER_TEMP:-}" ]; then
  export PATH="${RUNNER_TEMP}/gh-aw/mcp-cli/bin:${PATH}"
fi

require_tool git
require_tool node
require_tool npm
require_tool safeoutputs

echo "git=$(command -v git)"
echo "node=$(command -v node)"
echo "npm=$(command -v npm)"
echo "safeoutputs=$(command -v safeoutputs)"

git --version
node --version
npm --version

require_safeoutput() {
  local tool="$1"

  if ! safeoutputs "$tool" --help >/dev/null 2>&1; then
    fail "safeoutputs does not expose $tool"
  fi
}

require_safeoutput create_pull_request
require_safeoutput push_to_pull_request_branch

echo "Delivery V2 effective sandbox toolchain preflight: PASS"

if [ "${DELIVERY_V2_PREFLIGHT_ONLY:-false}" = "true" ]; then
  echo "DELIVERY_V2_PREFLIGHT_ONLY=true; Codex provider invocation skipped."
  exit 0
fi

require_tool codex

exec codex "$@"
