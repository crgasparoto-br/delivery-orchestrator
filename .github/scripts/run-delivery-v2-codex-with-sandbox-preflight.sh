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

require_tool cat
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

for tool in cat git sed node npm pnpm safeoutputs; do
  require_child_tool "$tool"
done

# npm itself uses /usr/bin/env node. Running npm here proves that node remains
# resolvable through the compatibility login-shell probe. Actual Codex command
# shells are forced to non-login mode below.
/bin/bash -lc 'cat /dev/null >/dev/null && git --version >/dev/null && node --version >/dev/null && npm --version >/dev/null && pnpm --version >/dev/null' ||
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

# Codex command subprocesses can replace the environment-policy PATH with the
# native package's restricted codex-path. The required shims are staged on the
# GitHub runner host by ensure-delivery-v2-worker-sandbox-toolchain.mjs before
# AWF enters the read-only chroot. This wrapper intentionally performs no write
# to /usr/local or codex-path.
resolve_codex_command_path() {
  local codex_executable codex_real codex_root

  codex_executable="$(command -v codex)"
  codex_real="$(readlink -f "$codex_executable" 2>/dev/null || printf '%s\n' "$codex_executable")"
  codex_root="$(cd "$(dirname "$codex_real")/.." && pwd -P)"

  find "$codex_root" -type d -name codex-path -print -quit 2>/dev/null || true
}

CODEX_COMMAND_PATH="$(resolve_codex_command_path)"

[ -n "$CODEX_COMMAND_PATH" ] ||
  fail "Codex restricted codex-path could not be located"
[ -d "$CODEX_COMMAND_PATH" ] ||
  fail "Codex restricted command path is not a directory: $CODEX_COMMAND_PATH"

for tool in bash cat git sed node npm pnpm safeoutputs; do
  [ -x "$CODEX_COMMAND_PATH/$tool" ] ||
    fail "$tool was not staged into Codex restricted command PATH before AWF started"
done

PATH="$CODEX_COMMAND_PATH" /bin/bash -c '
  set -e
  command -v bash >/dev/null
  command -v cat >/dev/null
  command -v git >/dev/null
  command -v sed >/dev/null
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v pnpm >/dev/null
  command -v safeoutputs >/dev/null
  cat /dev/null >/dev/null
  git --version >/dev/null
  node --version >/dev/null
  npm --version >/dev/null
  pnpm --version >/dev/null
  safeoutputs noop --help >/dev/null
' || fail "host-staged tools are not executable from Codex restricted command PATH"

echo "Delivery V2 Codex restricted command PATH toolchain: PASS"
echo "codex_command_path=$CODEX_COMMAND_PATH"

# Codex shell tools default to login shells. Inside the AWF worker this
# re-runs the login profile and replaces the curated PATH assembled above,
# hiding the toolcache and safeoutputs CLI from the actual commands executed
# by the agent. Force non-login command shells so the proven PATH is preserved.
# Codex may construct a restricted command PATH containing only its internal
# vendor command shim. Bind the already-validated Delivery V2 toolchain PATH
# explicitly into every Codex command subprocess. This keeps safeoutputs,
# pnpm, node, npm and git discoverable even if the model invokes bash -lc.
CODEX_SHELL_PATH="$PATH"
CODEX_BASH_ENV="$BASH_ENV"

# Bound the Codex conversation before gh-aw's context-rebuild circuit breaker
# is reached. Issue #250 observed almost 2M cumulative input tokens and a
# rebuild factor above the runtime threshold while the worker was still
# progressing.
#
# gh-aw trips only after both rebuild_factor >= 25 and cumulative input tokens
# >= 1,000,000. Keep the canonical CRITICAL allowance of 80 turns, but cap the
# full active Codex context at 10k tokens. Even the deliberately adversarial
# flat-context trajectory (80 requests at the cap) stays at 800k cumulative
# tokens, leaving 20% headroom below the gh-aw activation threshold.
CODEX_TOOL_OUTPUT_TOKEN_LIMIT="${DELIVERY_V2_CODEX_TOOL_OUTPUT_TOKEN_LIMIT:-2048}"
CODEX_AUTO_COMPACT_TOKEN_LIMIT="${DELIVERY_V2_CODEX_AUTO_COMPACT_TOKEN_LIMIT:-10000}"
CODEX_TOOL_OUTPUT_TOKEN_LIMIT_MAX=2048
CODEX_AUTO_COMPACT_TOKEN_LIMIT_MAX=10000
GH_AW_CONTEXT_REBUILD_MIN_CUMULATIVE_INPUT_TOKENS=1000000
DELIVERY_V2_CRITICAL_MAX_AI_TURNS=80

require_bounded_positive_integer() {
  local name="$1"
  local value="$2"
  local max="$3"

  case "$value" in
    ''|*[!0-9]*|0|0[0-9]*)
      fail "$name must be a canonical positive integer, got: $value"
      ;;
  esac

  if [ "${#value}" -gt "${#max}" ] ||
     { [ "${#value}" -eq "${#max}" ] && [[ "$value" > "$max" ]]; }; then
    fail "$name must be <= $max, got: $value"
  fi
}

require_bounded_positive_integer \
  DELIVERY_V2_CODEX_TOOL_OUTPUT_TOKEN_LIMIT \
  "$CODEX_TOOL_OUTPUT_TOKEN_LIMIT" \
  "$CODEX_TOOL_OUTPUT_TOKEN_LIMIT_MAX"

require_bounded_positive_integer \
  DELIVERY_V2_CODEX_AUTO_COMPACT_TOKEN_LIMIT \
  "$CODEX_AUTO_COMPACT_TOKEN_LIMIT" \
  "$CODEX_AUTO_COMPACT_TOKEN_LIMIT_MAX"

CONSERVATIVE_CUMULATIVE_CONTEXT_TOKENS=$(( DELIVERY_V2_CRITICAL_MAX_AI_TURNS * CODEX_AUTO_COMPACT_TOKEN_LIMIT ))

if [ "$CONSERVATIVE_CUMULATIVE_CONTEXT_TOKENS" -ge "$GH_AW_CONTEXT_REBUILD_MIN_CUMULATIVE_INPUT_TOKENS" ]; then
  fail "Codex context budget can reach the gh-aw cumulative rebuild threshold"
fi

echo "Delivery V2 Codex context budget:"
echo "tool_output_token_limit=$CODEX_TOOL_OUTPUT_TOKEN_LIMIT"
echo "model_auto_compact_token_limit=$CODEX_AUTO_COMPACT_TOKEN_LIMIT"
echo "model_auto_compact_token_limit_scope=total"
echo "critical_max_ai_turns=$DELIVERY_V2_CRITICAL_MAX_AI_TURNS"
echo "conservative_cumulative_context_tokens=$CONSERVATIVE_CUMULATIVE_CONTEXT_TOKENS"

exec codex \
  -c allow_login_shell=false \
  -c "tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}" \
  -c "model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}" \
  -c model_auto_compact_token_limit_scope=total \
  -c "shell_environment_policy.set.PATH=\"${CODEX_SHELL_PATH}\"" \
  -c "shell_environment_policy.set.BASH_ENV=\"${CODEX_BASH_ENV}\"" \
  "$@"
