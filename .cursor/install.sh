#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for VRCloud IDE.
# Installs Node dependencies (builds the node-pty native addon) and creates a
# development .env with dev credentials if one does not already exist.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[install] Installing npm dependencies..."
npm install

WORKSPACE_DIR="${VRCLOUD_WORKSPACE:-$HOME/vrcloud-workspace}"
mkdir -p "$WORKSPACE_DIR"
if [ ! -e "$WORKSPACE_DIR/README.txt" ]; then
  cat > "$WORKSPACE_DIR/README.txt" <<'EOF'
Welcome to your VRCloud IDE workspace.

This directory is the root shown in the file manager and terminals.
Create files, open terminals, and edit code from the browser IDE.
EOF
fi

if [ ! -f .env ]; then
  echo "[install] Generating development .env (dev credentials, non-production)..."
  cat > .env <<EOF
# Auto-generated development credentials for the Cloud Agent environment.
# Not for production use. COOKIE_SECURE stays false because dev is plain HTTP.
AUTH_USER=admin
AUTH_PASS=vrcloud-dev
AUTH_SECRET=$(openssl rand -hex 32)
COOKIE_SECURE=false
SESSION_MAX_AGE=604800
HOST=0.0.0.0
EOF
else
  echo "[install] Existing .env kept."
fi

echo "[install] Done."
