#!/usr/bin/env bash
# Kodu /opt/arzoom qovluğuna köçürdükdən sonra konteynerləri yeniləyir.
# DOMAIN verilibsə, .env-dəki SITE_ADDRESS onunla yenilənir (HTTPS sertifikatı bu ünvana alınır).
# NEW_POSTGRES_PASSWORD / NEW_ADMIN_TOKEN (GitHub secrets) verilibsə, parollar .env-də və bazada dəyişdirilir.
set -euo pipefail
cd /opt/arzoom

# Writes KEY='value' into .env (single quotes keep ! @ $ literal for both bash and Docker Compose).
set_env() {
  local k=$1 v=$2 tmp
  tmp=$(mktemp)
  grep -v "^$k=" .env > "$tmp" || true
  printf "%s='%s'\n" "$k" "${v//\'/}" >> "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"; chmod 600 .env
}
get_env() { grep "^$1=" .env | tail -1 | cut -d= -f2- | sed "s/^'//; s/'$//"; }

[ -n "${DOMAIN:-}" ] && set_env SITE_ADDRESS "$DOMAIN"
[ -n "${NEW_ADMIN_TOKEN:-}" ] && [ "$NEW_ADMIN_TOKEN" != "$(get_env ADMIN_TOKEN)" ] && set_env ADMIN_TOKEN "$NEW_ADMIN_TOKEN" && echo "ADMIN_TOKEN yeniləndi."

if [ -n "${NEW_POSTGRES_PASSWORD:-}" ] && [ "$NEW_POSTGRES_PASSWORD" != "$(get_env POSTGRES_PASSWORD)" ]; then
  # An existing database keeps its old password, so change it inside PostgreSQL first.
  if docker compose ps --status running db 2>/dev/null | grep -q db; then
    printf "ALTER USER arzoom PASSWORD :'pw';\n" | docker compose exec -T db psql -q -U arzoom -d arzoom -v pw="$NEW_POSTGRES_PASSWORD"
  fi
  set_env POSTGRES_PASSWORD "$NEW_POSTGRES_PASSWORD"
  echo "POSTGRES_PASSWORD yeniləndi."
fi

docker compose up -d --build --remove-orphans
# Caddyfile is a bind-mounted file: recreate Caddy so it reads the new version.
docker compose up -d --force-recreate --no-deps caddy
docker image prune -f >/dev/null
for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "Sağlamlıq yoxlaması keçdi. Ünvan: https://$(get_env SITE_ADDRESS)"; exit 0
  fi
  sleep 2
done
echo "Tətbiq cavab vermir:"; docker compose logs --tail=80 app caddy; exit 1
