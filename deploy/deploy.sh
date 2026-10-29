#!/usr/bin/env bash
# Kodu /opt/arzoom qovluğuna köçürdükdən sonra konteynerləri yeniləyir.
# DOMAIN verilibsə, .env-dəki SITE_ADDRESS onunla yenilənir (HTTPS sertifikatı bu ünvana alınır).
# WEBSITE_DOMAIN verilibsə (məs. "arzoomavto.az www.arzoomavto.az"), korporativ saytın WEBSITE_ADDRESS-i yenilənir;
# verilməyibsə, sayt https://SITE_ADDRESS:8443 ünvanında açılır.
# SOFTLINE_USER / SOFTLINE_KEY / SOFTLINE_SENDER verilibsə, SMS provayderi .env-ə yazılır.
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
# Robocall panel address (e.g. aicall.arzoomavto.az); kept in .env for later deploys.
[ -n "${AICALL_DOMAIN:-}" ] && set_env AICALL_ADDRESS "$AICALL_DOMAIN"
# Without a website domain the corporate site is served on the app's address, port 8443.
cur_web=$(get_env WEBSITE_ADDRESS || true)
if [ -n "${WEBSITE_DOMAIN:-}" ]; then
  set_env WEBSITE_ADDRESS "$WEBSITE_DOMAIN"
elif [ -z "$cur_web" ] || [[ "$cur_web" == *:8443 ]]; then
  set_env WEBSITE_ADDRESS "https://$(get_env SITE_ADDRESS):8443"
fi
command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active" && ufw allow 8443/tcp >/dev/null || true
# SMS (Softline): verilibsə .env-ə yazılır, sonrakı yeniləmələrdə yenidən vermək lazım deyil.
[ -n "${SOFTLINE_USER:-}" ] && set_env SOFTLINE_USER "$SOFTLINE_USER"
[ -n "${SOFTLINE_KEY:-}" ] && set_env SOFTLINE_KEY "$SOFTLINE_KEY" && echo "SMS açarı yeniləndi."
[ -n "${SOFTLINE_SENDER:-}" ] && set_env SOFTLINE_SENDER "$SOFTLINE_SENDER"
# Secret for SMS code hashes; created once so codes survive a restart.
[ -n "$(get_env OTP_SECRET || true)" ] || set_env OTP_SECRET "$(openssl rand -hex 32)"
# Backups and uploads hold customer data: only root may read them on the host.
mkdir -p backups && chmod 700 backups
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
    echo "Sağlamlıq yoxlaması keçdi. Ünvan: https://$(get_env SITE_ADDRESS)"
    w=$(get_env WEBSITE_ADDRESS || true); w=${w%% *}
    case "$w" in ""|http*) ;; *) w="https://$w" ;; esac
    [ -n "$w" ] && echo "Korporativ sayt: $w"
    if [ -n "$(get_env SOFTLINE_KEY || true)" ] || [ -n "$(get_env SMS_URL || true)" ]; then
      echo "SMS: qoşulub. Yoxlama: cd /opt/arzoom && docker compose exec app node sms-test.js 994XXXXXXXXX"
    else
      echo "DİQQƏT: SMS provayderi qoşulmayıb, saytda sınaq kodu 123456 göstərilir."
      echo "Qoşmaq üçün: curl -fsSL https://raw.githubusercontent.com/KamalMirzayev/ARZOOM/main/deploy/install.sh | sudo SOFTLINE_USER='...' SOFTLINE_KEY='...' bash"
    fi
    exit 0
  fi
  sleep 2
done
echo "Tətbiq cavab vermir:"; docker compose logs --tail=80 app caddy; exit 1
