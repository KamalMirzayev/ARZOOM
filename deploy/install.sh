#!/usr/bin/env bash
# Serverdə bir əmrlə quraşdırma və yeniləmə (GitHub secrets olmadan):
#   curl -fsSL https://raw.githubusercontent.com/KamalMirzayev/ARZOOM/main/deploy/install.sh | sudo NEW_POSTGRES_PASSWORD='...' NEW_ADMIN_TOKEN='...' DOMAIN='...' bash
# Hər dəfə işə salmaq olar: kodu yeniləyir, .env və ehtiyat nüsxələrə toxunmur.
set -euo pipefail
REPO=https://github.com/KamalMirzayev/ARZOOM.git
APP_DIR=/opt/arzoom
[ "$(id -u)" = 0 ] || { echo "root kimi işə sal: ... | sudo bash"; exit 1; }

for t in git curl openssl; do
  command -v $t >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git curl openssl ca-certificates >/dev/null; break; }
done

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 "$REPO" "$TMP/src"
mkdir -p "$APP_DIR"
# Copy code only; .env, backups and Docker volumes stay as they are.
(cd "$TMP/src" && tar --exclude=.git --exclude=.github -cf - .) | tar -xf - -C "$APP_DIR"
chmod +x "$APP_DIR"/deploy/*.sh

[ -f "$APP_DIR/.env" ] || bash "$APP_DIR/deploy/bootstrap.sh"
DOMAIN="${DOMAIN:-$(curl -fsS4 --max-time 5 https://api.ipify.org || true)}" \
NEW_POSTGRES_PASSWORD="${NEW_POSTGRES_PASSWORD:-}" NEW_ADMIN_TOKEN="${NEW_ADMIN_TOKEN:-}" \
  bash "$APP_DIR/deploy/deploy.sh"
echo
echo "Hazırdır. Müştəri səhifəsi: https://${DOMAIN:-SERVER_IP}  Əməkdaş paneli: https://${DOMAIN:-SERVER_IP}/admin"
