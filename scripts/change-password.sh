#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root: sudo /opt/vrcloud-ide/scripts/change-password.sh" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/vrcloud-ide}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
MODE="${1:-interactive}"

[[ -f "$ENV_FILE" ]] || { echo "Environment file not found: $ENV_FILE" >&2; exit 1; }

if [[ "$MODE" == "--generate" ]]; then
  NEW_PASSWORD="$(openssl rand -hex 24)"
elif [[ "$MODE" == "--from-env" ]]; then
  NEW_PASSWORD="${VR_PASSWORD:-}"
  [[ -n "$NEW_PASSWORD" ]] || { echo "VR_PASSWORD is empty." >&2; exit 1; }
elif [[ "$MODE" == "interactive" ]]; then
  if [[ ! -t 0 ]]; then
    echo "Interactive input requires a terminal." >&2
    echo "Run locally: sudo $APP_DIR/scripts/change-password.sh" >&2
    echo "Or generate one: curl -fsSL https://raw.githubusercontent.com/bayar-gg/vrcloud-ide/main/scripts/change-password.sh | sudo bash -s -- --generate" >&2
    exit 1
  fi
  read -r -s -p "New password (minimum 12 characters): " NEW_PASSWORD
  echo
  read -r -s -p "Confirm new password: " CONFIRM_PASSWORD
  echo
  [[ "$NEW_PASSWORD" == "$CONFIRM_PASSWORD" ]] || { echo "Passwords do not match." >&2; exit 1; }
else
  echo "Unknown option: $MODE" >&2
  echo "Supported: --generate, --from-env, or no option for interactive mode." >&2
  exit 1
fi

[[ ${#NEW_PASSWORD} -ge 12 ]] || { echo "Password must contain at least 12 characters." >&2; exit 1; }
[[ "$NEW_PASSWORD" != *$'\n'* && "$NEW_PASSWORD" != *$'\r'* ]] ||
  { echo "Password cannot contain a newline." >&2; exit 1; }
[[ ! "$NEW_PASSWORD" =~ ^[[:space:]] && ! "$NEW_PASSWORD" =~ [[:space:]]$ ]] ||
  { echo "Password cannot start or end with whitespace." >&2; exit 1; }

NEW_SECRET="$(openssl rand -hex 32)"
export ENV_FILE NEW_PASSWORD NEW_SECRET
python3 <<'PY'
import os
import stat

path = os.environ["ENV_FILE"]
password = os.environ["NEW_PASSWORD"]
secret = os.environ["NEW_SECRET"]
metadata = os.stat(path)

with open(path, "r", encoding="utf-8") as handle:
    lines = handle.read().splitlines()

def replace(lines, key, value):
    prefix = key + "="
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            lines[index] = prefix + value
            return
    lines.append(prefix + value)

replace(lines, "AUTH_PASS", password)
replace(lines, "AUTH_SECRET", secret)

temporary = path + ".tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
os.chown(temporary, metadata.st_uid, metadata.st_gid)
os.replace(temporary, path)
PY
unset NEW_SECRET

SERVICE="${VRCLOUD_SERVICE:-vrcloud-ide}"
if ! systemctl cat "$SERVICE" >/dev/null 2>&1; then
  SERVICE="cloud9-clone"
fi
systemctl restart "$SERVICE"

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$SERVICE"; then break; fi
  sleep 1
done
systemctl is-active --quiet "$SERVICE" || {
  systemctl status "$SERVICE" --no-pager >&2 || true
  exit 1
}

USERNAME="$(awk -F= '$1 == "AUTH_USER" { print substr($0, index($0, "=") + 1); exit }' "$ENV_FILE")"
echo "VRCloud IDE password updated. Existing login sessions were invalidated."
echo "Username: ${USERNAME:-admin}"
if [[ "$MODE" == "--generate" ]]; then
  echo "Generated password: $NEW_PASSWORD"
fi
