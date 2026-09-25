#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "VRCloud bootstrap must run as root." >&2
  echo "Use: curl -fsSL https://raw.githubusercontent.com/bayar-gg/vrcloud-ide/main/scripts/bootstrap.sh | sudo bash" >&2
  exit 1
fi

REPOSITORY="${VRCLOUD_REPOSITORY:-https://github.com/bayar-gg/vrcloud-ide.git}"
BRANCH="${VRCLOUD_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/vrcloud-ide}"
WORKSPACE="${WORKSPACE:-/srv/vrcloud-workspace}"
PORT="${PORT:-1337}"
# Node.js: the AI agent (@cursor/sdk) needs >= 22.13 and node-pty 1.x needs >= 16.
# Install the latest release of an LTS line (default 22 "Jod"); override with
# NODE_MAJOR=24 or pin an exact version with NODE_VERSION=22.x.y.
NODE_MAJOR="${NODE_MAJOR:-22}"
NODE_MIN_MAJOR=22

echo "[1/5] Installing base operating-system packages..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git xz-utils build-essential python3 tmux zip unzip openssl

# Browser headless untuk tool otomasi browser agent AI (navigate/click/screenshot via CDP).
# Opsional: kalau paket tidak ada, IDE tetap jalan dan tool browser melapor "tidak ditemukan".
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
  echo "      Installing Chromium for AI browser automation (optional)..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y chromium fonts-liberation 2>/dev/null \
    || DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser fonts-liberation 2>/dev/null \
    || {
      # Tanpa paket distro: IDE bisa mengunduh Chrome for Testing dari Preferences → Server.
      # Pasang pustaka runtime yang dibutuhkan build itu supaya langsung bisa jalan.
      echo "      Chromium not in apt; installing runtime libs for the in-app Chrome for Testing download..."
      DEBIAN_FRONTEND=noninteractive apt-get install -y fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libgbm1 libasound2 libxkbcommon0 libgtk-3-0 libxdamage1 libxcomposite1 libxrandr2 libxfixes3 libpango-1.0-0 2>/dev/null \
        || true
      echo "      Then open Preferences → Server → 'Unduh Chromium', or set VRCLOUD_BROWSER=<path> in .env"
    }
fi

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
if [[ -z "${NODE_VERSION:-}" ]]; then
  # Resolve the newest vNODE_MAJOR.x.y from the official dist index.
  curl -fsSLo "$TMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt"
  # (sed only: Debian's default awk is mawk, which lacks 3-argument match())
  NODE_VERSION="$(sed -nE 's/.*node-v([0-9]+\.[0-9]+\.[0-9]+)-linux-'"$NODE_ARCH"'\.tar\.xz$/\1/p' "$TMP_DIR/SHASUMS256.txt" | head -n1)"
  [[ -n "$NODE_VERSION" ]] || { echo "Could not resolve the latest Node.js ${NODE_MAJOR}.x release." >&2; exit 1; }
else
  curl -fsSLo "$TMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
fi
if (( ${NODE_VERSION%%.*} < NODE_MIN_MAJOR )); then
  echo "Node.js ${NODE_VERSION} is too old: VRCloud IDE requires Node.js >= ${NODE_MIN_MAJOR}.13." >&2; exit 1
fi

NODE_PACKAGE="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_ROOT="/opt/${NODE_PACKAGE}"
if [[ ! -x "$NODE_ROOT/bin/node" ]]; then
  echo "[2/5] Installing Node.js ${NODE_VERSION}..."
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PACKAGE}.tar.xz" \
    -o "$TMP_DIR/${NODE_PACKAGE}.tar.xz"
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
  echo "      Existing install found; updating to the latest ${BRANCH:-main}."
  echo "      Tip: after this you can update anytime with: sudo vrcloud update"
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" fetch --depth 1 "$REPOSITORY" "${BRANCH:-main}"
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" reset --hard FETCH_HEAD
elif [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
  echo "$APP_DIR exists and is not an empty Git repository." >&2
  exit 1
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPOSITORY" "$APP_DIR"
fi

echo "[4/5] Installing VRCloud services..."
# Strip CRLF and restore +x before bash runs the installer (Windows git checkout).
if [[ -f "$APP_DIR/scripts/install-systemd.sh" ]]; then
  sed -i 's/\r$//' "$APP_DIR/scripts/install-systemd.sh" "$APP_DIR/scripts/"*.sh "$APP_DIR/scripts/vrcloud" 2>/dev/null || true
  chmod 755 "$APP_DIR/scripts/install-systemd.sh" "$APP_DIR/scripts/"*.sh "$APP_DIR/scripts/vrcloud" 2>/dev/null || true
fi
export WORKSPACE PORT
export VRCLOUD_ROOT_ACCESS="${VRCLOUD_ROOT_ACCESS:-true}"
export SHELL_BIN="${SHELL_BIN:-/bin/bash}"
export RESET_PASSWORD="${RESET_PASSWORD:-false}"
if [[ -n "${VR_PASSWORD:-}" ]]; then export VR_PASSWORD; fi
bash "$APP_DIR/scripts/install-systemd.sh"

echo "[5/5] Verifying installation..."
systemctl is-enabled --quiet vrcloud-ide
if [[ ! -x /usr/local/bin/vrcloud ]]; then
  echo "vrcloud CLI is not executable: /usr/local/bin/vrcloud" >&2
  ls -l /usr/local/bin/vrcloud "$APP_DIR/scripts/vrcloud" >&2 || true
  exit 1
fi
# Smoke-test the CLI (status may be inactive; the command itself must run).
if ! /usr/local/bin/vrcloud help >/dev/null; then
  echo "vrcloud CLI failed to run." >&2
  exit 1
fi
if systemctl is-active --quiet vrcloud-ide; then
  echo "Service should remain stopped after installation." >&2
  exit 1
fi
detect_ip() {
  local ip="" url
  for url in https://ip.me https://ifconfig.me https://api.ipify.org; do
    ip="$(curl -fsS4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')"
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { printf '%s' "$ip"; return 0; }
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}
SERVER_IP="$(detect_ip)"

echo
echo "VRCloud IDE installation completed successfully."
echo "Service is installed but stopped."
echo "Start: vrcloud start"
echo "Stop: vrcloud stop"
echo "Update: vrcloud update"
echo "Login: vrcloud password"
echo "Change password: vrcloud newpassword"
echo "URL after start: https://${SERVER_IP}:${PORT}/"
