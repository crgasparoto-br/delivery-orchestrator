#!/usr/bin/env bash
set -euo pipefail

implementer_user="${DELIVERY_IMPLEMENTER_USER:-delivery-implementer}"
auditor_user="${DELIVERY_AUDITOR_USER:-delivery-auditor}"
runner_user="${1:-${SUDO_USER:-}}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root (for example: sudo bash scripts/bootstrap-runner-roles.sh <runner-user>)." >&2
  exit 1
fi

if [ -z "$runner_user" ] || ! id "$runner_user" >/dev/null 2>&1; then
  echo "A valid GitHub Actions runner user is required as the first argument." >&2
  exit 1
fi

if [ "$implementer_user" = "$auditor_user" ]; then
  echo "Implementer and auditor users must be different." >&2
  exit 1
fi

for role_user in "$implementer_user" "$auditor_user"; do
  if ! id "$role_user" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$role_user"
    echo "Created role user: $role_user"
  else
    echo "Role user already exists: $role_user"
  fi
done

sudoers_file="/etc/sudoers.d/delivery-orchestrator-roles"
printf '%s ALL=(%s,%s) NOPASSWD: ALL\n' "$runner_user" "$implementer_user" "$auditor_user" > "$sudoers_file"
chmod 440 "$sudoers_file"
visudo -cf "$sudoers_file" >/dev/null

venv_probe="$(mktemp -d)"
trap 'rm -rf "$venv_probe"' EXIT
if ! python3 -m venv "$venv_probe/venv" >/dev/null 2>&1; then
  echo "python3 venv support is required. On Debian/Ubuntu install python3-venv and run this script again." >&2
  exit 1
fi

codex_bin="$(command -v codex || true)"
if [ -z "$codex_bin" ]; then
  echo "Codex CLI is required for the one-time role device-auth bootstrap." >&2
  echo "Install it system-wide so both role users can execute it: sudo npm install -g @openai/codex" >&2
  exit 1
fi

for role_user in "$implementer_user" "$auditor_user"; do
  if ! sudo -n -u "$runner_user" -H -- sudo -n -u "$role_user" -H -- true; then
    echo "Runner user cannot execute commands as $role_user without interaction." >&2
    exit 1
  fi
  if ! sudo -n -u "$role_user" -H -- "$codex_bin" --version >/dev/null 2>&1; then
    echo "Codex CLI at $codex_bin is not executable by $role_user." >&2
    echo "Install it in a system-wide location accessible to both role users." >&2
    exit 1
  fi
done

echo "Runner role bootstrap completed."
echo "Codex CLI available to both isolated role users: $codex_bin"
echo "Next: perform the documented Codex device-auth login separately as $implementer_user and $auditor_user."
