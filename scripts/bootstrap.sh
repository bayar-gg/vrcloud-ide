#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "VRCloud bootstrap must run as root." >&2
  echo "Use: curl -fsSL https://raw.githubusercontent.com/bayar-gg/vrcloud-ide/main/scripts/bootstrap.sh | sudo bash" >&2
  exit 1
fi

REPOSITORY="https://github.com/bayar-gg/vrcloud-ide.git"
APP_DIR="${APP_DIR:-/opt/vrcloud-ide}"
WORKSPACE="${WORKSPACE:-/srv/vrcloud-workspace}"
PORT="${PORT:-1337}"
NODE_VERSION="12.22.12"

echo "[1/5] Installing base operating-system packages..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git xz-utils build-essential python3 tmux zip unzip openssl

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

NODE_PACKAGE="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_ROOT="/opt/${NODE_PACKAGE}"
if [[ ! -x "$NODE_ROOT/bin/node" ]]; then
  echo "[2/5] Installing Node.js ${NODE_VERSION}..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PACKAGE}.tar.xz" \
    -o "$TMP_DIR/${NODE_PACKAGE}.tar.xz"
  curl -fsSLo "$TMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  EXPECTED="$(awk -v file="${NODE_PACKAGE}.tar.xz" '$2 == file { print $1 }' "$TMP_DIR/SHASUMS256.txt")"
  [[ -n "$EXPECTED" ]] || { echo "Node.js checksum not found." >&2; exit 1; }
  printf '%s  %s\n' "$EXPECTED" "$TMP_DIR/${NODE_PACKAGE}.tar.xz" | sha256sum -c -
  tar -xJf "$TMP_DIR/${NODE_PACKAGE}.tar.xz" -C /opt
else
  echo "[2/5] Node.js ${NODE_VERSION} is already installed."
fi
ln -sfn "$NODE_ROOT/bin/node" /usr/local/bin/node
ln -sfn "$NODE_ROOT/bin/npm" /usr/local/bin/npm
ln -sfn "$NODE_ROOT/bin/npx" /usr/local/bin/npx

echo "[3/5] Downloading VRCloud IDE..."
if [[ -d "$APP_DIR/.git" ]]; then
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" pull --ff-only
elif [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
  echo "$APP_DIR exists and is not an empty Git repository." >&2
  exit 1
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPOSITORY" "$APP_DIR"
fi

echo "[4/5] Installing VRCloud services..."
export WORKSPACE PORT
export RESET_PASSWORD="${RESET_PASSWORD:-false}"
if [[ -n "${VR_PASSWORD:-}" ]]; then export VR_PASSWORD; fi
bash "$APP_DIR/scripts/install-systemd.sh"

echo "[5/5] Verifying installation..."
systemctl is-enabled --quiet vrcloud-ide
[[ -x /usr/local/bin/vrcloud ]]
if systemctl is-active --quiet vrcloud-ide; then
  echo "Service should remain stopped after installation." >&2
  exit 1
fi
SERVER_IP="$(hostname -I | awk '{print $1}')"

echo
echo "VRCloud IDE installation completed successfully."
echo "Service is installed but stopped."
echo "Start: vrcloud start"
echo "Stop: vrcloud stop"
echo "Login: vrcloud password"
echo "Change password: vrcloud newpassword"
echo "URL after start: http://${SERVER_IP}:${PORT}/"
