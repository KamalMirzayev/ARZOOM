#!/usr/bin/env bash
# Serverdə bir dəfə işə salınır: Docker quraşdırır, /opt/arzoom qovluğunu və .env faylını yaradır.
set -euo pipefail
APP_DIR=/opt/arzoom
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
mkdir -p "$APP_DIR"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
ADMIN_TOKEN=$(openssl rand -hex 24)
DEMO_SMS=true
HTTP_PORT=80
ENV
  chmod 600 "$APP_DIR/.env"
  echo ".env yaradıldı: $APP_DIR/.env (ADMIN_TOKEN burada saxlanılır)"
fi
echo "Hazırdır."
