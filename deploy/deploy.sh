#!/usr/bin/env bash
# Kodu /opt/arzoom qovluğuna köçürdükdən sonra konteynerləri yeniləyir.
# DOMAIN verilibsə, .env-dəki SITE_ADDRESS onunla yenilənir (HTTPS sertifikatı bu ünvana alınır).
set -euo pipefail
cd /opt/arzoom
if [ -n "${DOMAIN:-}" ]; then
  if grep -q '^SITE_ADDRESS=' .env; then sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${DOMAIN}|" .env; else echo "SITE_ADDRESS=${DOMAIN}" >> .env; fi
fi
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "Sağlamlıq yoxlaması keçdi. Ünvan: https://$(grep '^SITE_ADDRESS=' .env | cut -d= -f2)"; exit 0
  fi
  sleep 2
done
echo "Tətbiq cavab vermir:"; docker compose logs --tail=80 app caddy; exit 1
