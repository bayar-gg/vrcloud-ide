#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/setup-https-ip.sh [PUBLIC_IP]" >&2
  exit 1
fi

PUBLIC_IP="${1:-${PUBLIC_IP:-}}"
PORT="${PORT:-1337}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WEBROOT="/var/www/vrcloud-acme"
SITE="/etc/nginx/sites-available/vrcloud-ide"
CERTBOT="/snap/bin/certbot"

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(curl -4fsS https://api.ipify.org)"
fi
if [[ ! "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "Invalid public IPv4 address: $PUBLIC_IP" >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx snapd curl ca-certificates
if [[ ! -x "$CERTBOT" ]]; then
  snap install certbot --classic
fi

mkdir -p "$WEBROOT/.well-known/acme-challenge"
rm -f /etc/nginx/sites-enabled/default

cat > "$SITE" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${PUBLIC_IP};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 200 "VRCloud IDE HTTPS setup in progress\\n";
        add_header Content-Type text/plain;
    }
}
EOF
ln -sfn "$SITE" /etc/nginx/sites-enabled/vrcloud-ide
nginx -t
systemctl enable --now nginx
systemctl reload nginx

"$CERTBOT" certonly \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path "$WEBROOT" \
  --ip-address "$PUBLIC_IP"

cat > "$SITE" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${PUBLIC_IP};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 301 https://${PUBLIC_IP}:${PORT}\$request_uri;
    }
}

server {
    listen ${PUBLIC_IP}:${PORT} ssl;
    server_name ${PUBLIC_IP};

    ssl_certificate /etc/letsencrypt/live/${PUBLIC_IP}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_IP}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:VRCloudTLS:10m;
    ssl_session_timeout 1d;

    error_page 497 =301 https://${PUBLIC_IP}:${PORT}\$request_uri;
    client_max_body_size 500m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name ${PUBLIC_IP};

    ssl_certificate /etc/letsencrypt/live/${PUBLIC_IP}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_IP}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:VRCloudTLS:10m;
    ssl_session_timeout 1d;

    client_max_body_size 500m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-vrcloud-nginx.sh <<'EOF'
#!/usr/bin/env bash
set -e
/usr/sbin/nginx -t >/dev/null 2>&1
/usr/bin/systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-vrcloud-nginx.sh

if [[ -f "$APP_DIR/.env" ]]; then
  if grep -q '^COOKIE_SECURE=' "$APP_DIR/.env"; then
    sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' "$APP_DIR/.env"
  else
    printf '\nCOOKIE_SECURE=true\n' >> "$APP_DIR/.env"
  fi
fi

nginx -t
systemctl reload nginx
echo "Trusted HTTPS enabled: https://${PUBLIC_IP}:${PORT}/"
