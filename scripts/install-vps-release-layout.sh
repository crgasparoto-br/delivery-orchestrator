#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

SOURCE_REPO="${ORCHESTRATOR_SOURCE_REPO:-/opt/delivery-orchestrator}"
ENV_FILE="/etc/delivery-orchestrator/hygiene.env"

if [ ! -d "$SOURCE_REPO/.git" ]; then
  echo "Source checkout not found at $SOURCE_REPO" >&2
  exit 1
fi

install -d -m 755 /etc/delivery-orchestrator
install -d -m 755 /opt/delivery-orchestrator-runtime/releases
install -d -m 755 /var/log/delivery-orchestrator/branch-hygiene
install -d -m 755 /var/log/delivery-orchestrator/release-update
install -d -m 755 /var/lib/delivery-orchestrator/release-validation

if [ ! -f "$ENV_FILE" ]; then
  cp "$SOURCE_REPO/deploy/systemd/hygiene.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Configure ORCHESTRATOR_REPOSITORIES and GITHUB_TOKEN before enabling the timer." >&2
  exit 2
fi

ensure_env() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

ensure_env ORCHESTRATOR_SOURCE_REPO /opt/delivery-orchestrator
ensure_env ORCHESTRATOR_RELEASES_DIR /opt/delivery-orchestrator-runtime/releases
ensure_env ORCHESTRATOR_CURRENT_LINK /opt/delivery-orchestrator-runtime/current
ensure_env ORCHESTRATOR_RELEASE_LOG_DIR /var/log/delivery-orchestrator/release-update
ensure_env ORCHESTRATOR_RELEASE_VALIDATION_DIR /var/lib/delivery-orchestrator/release-validation
ensure_env ORCHESTRATOR_RELEASE_LOCK_FILE /run/lock/delivery-orchestrator-release-hygiene-process.lock
ensure_env ORCHESTRATOR_RELEASE_RETENTION 3
chmod 600 "$ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

/usr/bin/flock -n /run/lock/delivery-orchestrator-release-hygiene.lock \
  /usr/bin/node "$SOURCE_REPO/scripts/vps-release-hygiene.mjs" --bootstrap --update-only

cp "$SOURCE_REPO/deploy/systemd/delivery-orchestrator-branch-hygiene.service" /etc/systemd/system/
cp "$SOURCE_REPO/deploy/systemd/delivery-orchestrator-branch-hygiene.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now delivery-orchestrator-branch-hygiene.timer
systemctl status delivery-orchestrator-branch-hygiene.timer --no-pager -l
