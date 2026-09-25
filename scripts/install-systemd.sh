#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this installer as root: sudo bash scripts/install-systemd.sh" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Root access is the default: browser terminals run as root so apt/sudo work.
# Set VRCLOUD_ROOT_ACCESS=false to install the restricted `vrcloud` account.
ROOT_ACCESS="${VRCLOUD_ROOT_ACCESS:-true}"
case "${ROOT_ACCESS,,}" in
  true|1|yes)
    if [[ -n "${VRCLOUD_USER:-}" && "$VRCLOUD_USER" != "root" ]]; then
      echo "VRCLOUD_ROOT_ACCESS cannot be combined with VRCLOUD_USER=$VRCLOUD_USER." >&2
      exit 1
    fi
    SERVICE_USER="root"
    NO_NEW_PRIVILEGES="false"
    ;;
  false|0|no)
    SERVICE_USER="${VRCLOUD_USER:-vrcloud}"
    NO_NEW_PRIVILEGES="true"
    ;;
  *)
    echo "VRCLOUD_ROOT_ACCESS must be true or false." >&2
    exit 1
    ;;
esac
WORKSPACE="${WORKSPACE:-/srv/vrcloud-workspace}"
PORT="${PORT:-1337}"
SHELL_BIN="${SHELL_BIN:-/bin/bash}"
SERVICE_FILE="/etc/systemd/system/vrcloud-ide.service"

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
# @cursor/sdk (AI agent) requires Node.js >= 22.13; node-pty 1.x requires >= 16.
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJ="${NODE_VER%%.*}"; NODE_MIN="$(echo "$NODE_VER" | cut -d. -f2)"
if (( NODE_MAJ < 22 )) || { (( NODE_MAJ == 22 )) && (( NODE_MIN < 13 )); }; then
  echo "Node.js ${NODE_VER} is too old. VRCloud IDE requires Node.js >= 22.13 (use scripts/bootstrap.sh or install Node 22/24 LTS)." >&2
  exit 1
fi
SHELL_PATH="$(command -v "$SHELL_BIN")" ||
  { echo "Configured shell is not executable: $SHELL_BIN" >&2; exit 1; }

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  tmux zip unzip git build-essential python3 ca-certificates curl

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

mkdir -p "$WORKSPACE" "$APP_DIR/data"
cd "$APP_DIR"
npm ci --production

GENERATED_PASSWORD=""
if [[ ! -f .env ]]; then
  GENERATED_PASSWORD="$(openssl rand -hex 24)"
  GENERATED_SECRET="$(openssl rand -hex 32)"
  umask 077
  cat > .env <<EOF
AUTH_USER=admin
AUTH_PASS=${GENERATED_PASSWORD}
AUTH_SECRET=${GENERATED_SECRET}
COOKIE_SECURE=true
HTTPS=true
SESSION_MAX_AGE=604800
EOF
fi
# Akses langsung https://IP:PORT (sertifikat self-signed dibuat server).
# HTTPS=false di .env tetap dihormati bila pengguna mematikannya.
if ! grep -q '^HTTPS=' .env; then
  printf '\nHTTPS=true\n' >> .env
fi
if grep -q '^COOKIE_SECURE=' .env; then
  if ! grep -q '^HTTPS=false' .env; then
    sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env
  fi
else
  printf '\nCOOKIE_SECURE=true\n' >> .env
fi
if grep -q '^HOST=' .env; then
  sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env
else
  printf 'HOST=0.0.0.0\n' >> .env
fi
chmod 600 .env

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
if [[ "$SERVICE_USER" != "root" ]]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$WORKSPACE"
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=VRCloud IDE (persistent realtime web IDE)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=WORKSPACE=${WORKSPACE}
Environment=HOME=${SERVICE_HOME}
Environment=SHELL_BIN=${SHELL_PATH}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=15
LimitNOFILE=65536
NoNewPrivileges=${NO_NEW_PRIVILEGES}

[Install]
WantedBy=multi-user.target
EOF

# Windows git often commits these as 644 + CRLF. That makes
# `vrcloud` fail on Ubuntu with: bash: /usr/local/bin/vrcloud: Permission denied
normalize_script() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  sed -i 's/\r$//' "$f"
  chmod 755 "$f"
}
normalize_script "$APP_DIR/scripts/vrcloud"
normalize_script "$APP_DIR/scripts/change-password.sh"
normalize_script "$APP_DIR/scripts/bootstrap.sh"
normalize_script "$APP_DIR/scripts/install-systemd.sh"
normalize_script "$APP_DIR/start.sh"

# Install a real 0755 wrapper so PATH never depends on the repo file mode.
cat > /usr/local/bin/vrcloud <<EOF
#!/bin/bash
exec bash "$APP_DIR/scripts/vrcloud" "\$@"
EOF
chmod 755 /usr/local/bin/vrcloud
systemctl daemon-reload
INSTALLED_USER="$(systemctl show vrcloud-ide.service --property=User --value)"
if [[ "$INSTALLED_USER" != "$SERVICE_USER" ]]; then
  echo "Service user verification failed: expected $SERVICE_USER, got ${INSTALLED_USER:-<empty>}." >&2
  exit 1
fi
systemctl enable vrcloud-ide >/dev/null
systemctl stop vrcloud-ide || true

PASSWORD_ROTATED=false
if [[ -n "${VR_PASSWORD:-}" ]]; then
  APP_DIR="$APP_DIR" VRCLOUD_SERVICE=vrcloud-ide VR_PASSWORD="$VR_PASSWORD" \
    bash "$APP_DIR/scripts/change-password.sh" --from-env
  PASSWORD_ROTATED=true
elif [[ "${RESET_PASSWORD:-false}" == "true" ]]; then
  APP_DIR="$APP_DIR" VRCLOUD_SERVICE=vrcloud-ide \
    bash "$APP_DIR/scripts/change-password.sh" --generate
  PASSWORD_ROTATED=true
fi

detect_ip() {
  local ip="" url
  for url in https://ip.me https://ifconfig.me https://api.ipify.org; do
    ip="$(curl -fsS4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')"
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { printf '%s' "$ip"; return 0; }
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}
ACCESS_URL="https://$(detect_ip):${PORT}"

echo
echo "VRCloud IDE installed but not started."
echo "URL after start: ${ACCESS_URL}"
echo "Workspace: ${WORKSPACE}"
echo "Service user: ${SERVICE_USER}"
echo "Terminal shell: ${SHELL_PATH}"
if [[ "$SERVICE_USER" == "root" ]]; then
  echo "WARNING: Browser terminals have unrestricted root access to this host."
  echo "Root commands such as apt and sudo are enabled in browser terminals."
else
  echo "Browser terminals are restricted: sudo and system package changes are disabled."
  echo "To enable them, rerun bootstrap from the VPS console with VRCLOUD_ROOT_ACCESS=true."
fi
echo "Username: admin"
if [[ "$PASSWORD_ROTATED" == "true" ]]; then
  echo "Password: final password was configured by the rotation step above"
elif [[ -n "$GENERATED_PASSWORD" ]]; then
  echo "Generated password: ${GENERATED_PASSWORD}"
else
  echo "Password: unchanged in ${APP_DIR}/.env"
  echo "Change password: vrcloud newpassword"
fi
echo
echo "Commands:"
echo "  vrcloud start"
echo "  vrcloud stop"
echo "  vrcloud restart"
echo "  vrcloud status"
echo "  vrcloud update"
echo "  vrcloud password"
echo "  vrcloud newpassword"
