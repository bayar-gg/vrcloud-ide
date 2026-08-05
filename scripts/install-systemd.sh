#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this installer as root: sudo bash scripts/install-systemd.sh" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${VRCLOUD_USER:-vrcloud}"
WORKSPACE="${WORKSPACE:-/srv/vrcloud-workspace}"
PORT="${PORT:-1337}"
SERVICE_FILE="/etc/systemd/system/vrcloud-ide.service"

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  tmux zip unzip git build-essential python3 ca-certificates curl

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi

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
COOKIE_SECURE=false
SESSION_MAX_AGE=604800
EOF
fi
# Auto-installer ini menggunakan HTTP langsung, jadi cookie harus dapat
# dikirim melalui http://IP:PORT walaupun .env berasal dari instalasi lama.
if grep -q '^COOKIE_SECURE=' .env; then
  sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=false/' .env
else
  printf '\nCOOKIE_SECURE=false\n' >> .env
fi
if grep -q '^HOST=' .env; then
  sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env
else
  printf 'HOST=0.0.0.0\n' >> .env
fi
chmod 600 .env

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$WORKSPACE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=VRCloud IDE (persistent realtime web IDE)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=WORKSPACE=${WORKSPACE}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=15
LimitNOFILE=65536
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

ln -sfn "$APP_DIR/scripts/vrcloud" /usr/local/bin/vrcloud
systemctl daemon-reload
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

ACCESS_URL="http://$(hostname -I | awk '{print $1}'):${PORT}"

echo
echo "VRCloud IDE installed but not started."
echo "URL after start: ${ACCESS_URL}"
echo "Workspace: ${WORKSPACE}"
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
echo "  vrcloud password"
echo "  vrcloud newpassword"
