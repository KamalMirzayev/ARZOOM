#!/usr/bin/env bash
# Kodu /opt/arzoom qovluğuna köçürdükdən sonra konteynerləri yeniləyir.
set -euo pipefail
cd /opt/arzoom
set -a; . ./.env; set +a
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:${HTTP_PORT:-80}/api/health >/dev/null 2>&1; then echo "Sağlamlıq yoxlaması keçdi."; exit 0; fi
  sleep 2
done
echo "Tətbiq cavab vermir:"; docker compose logs --tail=80 app; exit 1
