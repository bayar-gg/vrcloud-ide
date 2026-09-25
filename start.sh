#!/usr/bin/env bash
# Jalankan VRCloud IDE.
#   PORT       port HTTPS       (default 1337, buka https://IP:PORT)
#   WORKSPACE  folder kerja     (default: /root/GAS)
#   Login dibaca otomatis dari file .env
set -e
cd "$(dirname "$0")"

NODE="$(command -v node || echo /usr/local/bin/node)"
export PORT="${PORT:-1337}"
export WORKSPACE="${WORKSPACE:-/root/GAS}"

if [ ! -d node_modules ]; then
  echo "Memasang dependency dulu…"
  "${NODE%/node}/npm" install || npm install
fi

exec "$NODE" server.js
