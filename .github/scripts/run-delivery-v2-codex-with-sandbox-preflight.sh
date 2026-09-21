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
# inherit safeoutputs even when the outer sandbox command loses the host PATH.
if [ -n "${RUNNER_TEMP:-}" ]; then
  export PATH="${RUNNER_TEMP}/gh-aw/mcp-cli/bin:${PATH}"
fi

# Keep the verified toolcache entries already present in PATH, while also
# restoring the normal system locations needed by login/non-interactive shells.
export PATH="${PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

require_tool git
require_tool sed
require_tool node
require_tool npm
require_tool pnpm
require_tool safeoutputs
require_tool mktemp

# Codex executes commands through child bash shells. Those shells may rebuild
# PATH and discard the toolcache/MCP entries proven above. BASH_ENV is sourced
# by non-interactive bash processes, including the command shells used by Codex.
#
# RUNNER_TEMP is read-only inside awf, so keep this tiny trusted bootstrap in
# the sandbox-writable /tmp filesystem.
umask 077
DELIVERY_V2_BASH_ENV="$(mktemp /tmp/delivery-v2-shell-env.XXXXXX)"
printf 'export PATH=%q\n' "$PATH" > "$DELIVERY_V2_BASH_ENV"
export BASH_ENV="$DELIVERY_V2_BASH_ENV"

require_child_tool() {
  local tool="$1"
  /bin/bash -lc "command -v '$tool' >/dev/null 2>&1" ||
    fail "$tool is not available inside Codex child bash shells"
}

for tool in git sed node npm pnpm safeoutputs; do
  require_child_tool "$tool"
done

# npm itself uses /usr/bin/env node. Running npm here proves that node remains
# resolvable through the compatibility login-shell probe. Actual Codex command
# shells are forced to non-login mode below.
/bin/bash -lc 'git --version >/dev/null && node --version >/dev/null && npm --version >/dev/null && pnpm --version >/dev/null' ||
  fail "git/node/npm/pnpm execution failed inside sandbox child-shell probe"

echo "Delivery V2 Codex child-shell toolchain preflight: PASS"

echo "git=$(command -v git)"
echo "node=$(command -v node)"
echo "npm=$(command -v npm)"
echo "pnpm=$(command -v pnpm)"
echo "safeoutputs=$(command -v safeoutputs)"

git --version
node --version
npm --version
pnpm --version

require_safeoutput() {
  local tool="$1"

  if ! safeoutputs "$tool" --help >/dev/null 2>&1; then
    fail "safeoutputs does not expose $tool"
  fi
}

require_safeoutput create_pull_request
require_safeoutput push_to_pull_request_branch
require_safeoutput noop

/bin/bash -lc 'safeoutputs create_pull_request --help >/dev/null 2>&1 && safeoutputs push_to_pull_request_branch --help >/dev/null 2>&1 && safeoutputs noop --help >/dev/null 2>&1' ||
  fail "safeoutputs commands are not executable inside Codex child bash shells"

echo "Delivery V2 effective sandbox toolchain preflight: PASS"

if [ "${DELIVERY_V2_PREFLIGHT_ONLY:-false}" = "true" ]; then
  echo "DELIVERY_V2_PREFLIGHT_ONLY=true; Codex provider invocation skipped."
  exit 0
fi

require_tool codex

# Codex shell tools default to login shells. Inside the AWF worker this
# re-runs the login profile and replaces the curated PATH assembled above,
# hiding the toolcache and safeoutputs CLI from the actual commands executed
# by the agent. Force non-login command shells so the proven PATH is preserved.
# Codex may construct a restricted command PATH containing only its internal
# vendor command shim. Bind the already-validated Delivery V2 toolchain PATH
# explicitly into every Codex command subprocess. This keeps safeoutputs,
# pnpm, node, npm and git discoverable even if the model invokes bash -lc.
CODEX_SHELL_PATH="$PATH"

exec codex \
  -c allow_login_shell=false \
  -c "shell_environment_policy.set.PATH=\"${CODEX_SHELL_PATH}\"" \
  "$@"
