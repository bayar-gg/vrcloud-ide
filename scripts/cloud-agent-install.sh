#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for VRCloud IDE.
# Refreshes npm dependencies, generates a local dev .env if missing, and
# ensures the session-persistence directory exists. Safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")/.."

# Install/refresh dependencies. node-pty-prebuilt-multiarch resolves a prebuilt
# native binary, so no compile toolchain step is required on Node 22.
npm ci

# Generate a local login configuration for the dev IDE on first run only.
# These credentials are for the VM-local login page; they are not committed
# (.env is gitignored) and are regenerated per environment.
if [ ! -f .env ]; then
  AUTH_PASS="$(openssl rand -hex 24)"
  AUTH_SECRET="$(openssl rand -hex 32)"
  cat > .env <<EOF
AUTH_USER=admin
AUTH_PASS=${AUTH_PASS}
AUTH_SECRET=${AUTH_SECRET}
COOKIE_SECURE=false
SESSION_MAX_AGE=604800
HOST=0.0.0.0
EOF
  chmod 600 .env
  echo "Generated local .env (user: admin)."
fi

# Atomic shared-session persistence lives here.
mkdir -p data

echo "VRCloud IDE install complete."
