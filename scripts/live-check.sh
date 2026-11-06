#!/bin/bash
# Arzoom canlı yoxlama. Heç bir müraciət yaratmır, SMS göndərmir, məlumat dəyişmir.
# İşlətmək: curl -fsSL https://raw.githubusercontent.com/KamalMirzayev/ARZOOM/main/scripts/live-check.sh | sudo bash
A=https://lizinq.arzoomavto.az; S=https://arzoomavto.az
cd /opt/arzoom || exit 1
ok(){ echo "✓ $1"; }; no(){ echo "✗ $1"; }
c(){ curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }
q(){ docker compose exec -T db psql -U arzoom arzoom -tAc "$1"; }

echo "== Səhifələr və API =="
[ "$(c $A/)" = 200 ] && curl -s $A/ | grep -q 'arzoom' && ok "müraciət səhifəsi açılır" || no "müraciət səhifəsi"
[ "$(c $S/)" = 200 ] && ok "əsas sayt açılır" || no "əsas sayt"
curl -s "$S/" | grep -q 'lizinq.arzoomavto.az' && ok "saytda müraciət linki var" || no "saytda müraciət linki"
curl -s $A/api/health | grep -q '"ok":true' && ok "tətbiq: $(curl -s $A/api/health)" || no "tətbiq health"
N=$(curl -s $A/api/stock | python3 -c 'import json,sys;b=json.load(sys.stdin)["brands"];print(sum(len(v) for v in b.values()))' 2>/dev/null)
[ "${N:-0}" -gt 0 ] && ok "partnyor stoku: $N model" || no "partnyor stoku boşdur"
[ "$(c -X POST $A/api/applications)" = 400 ] && ok "boş müraciət rədd edilir (yoxlama işləyir)" || no "müraciət yoxlaması"
[ "$(c $A/api/applications/YOX-0000)" = 401 ] && ok "kabinet tokensiz açılmır" || no "kabinet qorunması"
[ "$(c -X POST $A/api/admin/login -H 'Content-Type: application/json' -d '{"username":"yoxlama","password":"yanlis-parol-123"}')" = 401 ] && ok "paneldə yanlış parol qəbul edilmir" || no "panel girişi"
[ "$(c $A/api/admin/applications)" = 401 ] && ok "panel API girişsiz bağlıdır" || no "panel API qorunması"
P=$(c $A/admin); [ "$P" = 200 ] || [ "$P" = 403 ] && ok "panel səhifəsi ($P)" || no "panel səhifəsi ($P)"
curl -sI $A/ | grep -qi 'strict-transport-security' && ok "HTTPS və təhlükəsizlik başlıqları" || no "təhlükəsizlik başlıqları"

echo "== Son 7 gün (bazadan) =="
echo "Müraciətlər statusa görə: $(q "SELECT string_agg(status||' '||n, ', ') FROM (SELECT status, count(*) n FROM applications WHERE created_at > now()-interval '7 days' GROUP BY 1) t")"
echo "SMS: göndərildi $(q "SELECT count(*) FROM application_events WHERE kind='sms' AND at > now()-interval '7 days' AND NOT details ? 'error'"), xəta $(q "SELECT count(*) FROM application_events WHERE kind='sms' AND at > now()-interval '7 days' AND details ? 'error'")"
q "SELECT '  son SMS xətası: '||(details->>'error') FROM application_events WHERE kind='sms' AND details ? 'error' ORDER BY at DESC LIMIT 1"
echo "Webhook: uğurlu $(q "SELECT count(*) FROM application_events WHERE kind='webhook' AND NOT details ? 'error'"), xəta $(q "SELECT count(*) FROM application_events WHERE kind='webhook' AND details ? 'error'")"
echo "Webhook ayarı: $(q "SELECT CASE WHEN count(*)=2 THEN 'qoşulub' ELSE 'qoşulmayıb' END FROM settings WHERE key IN ('partner_webhook_url','partner_webhook_token') AND value<>''")"
echo "Aktiv işçilər: $(q "SELECT string_agg(role||' '||n, ', ') FROM (SELECT role, count(*) n FROM staff_users WHERE active GROUP BY 1) t")"
B=$(ls -t backups/arzoom-*.sql.gz 2>/dev/null | head -1)
[ -n "$B" ] && [ $(( ($(date +%s) - $(stat -c %Y "$B")) / 3600 )) -lt 26 ] && ok "son backup: $B ($(du -h "$B" | cut -f1))" || no "son 26 saatda backup yoxdur: ${B:-heç biri}"
D=$(df -h /opt | awk 'NR==2{print $5}'); echo "Disk: $D dolu"
echo "Son 24 saatda tətbiq xətaları: $(docker compose logs --since 24h app 2>&1 | grep -ciE 'error|xəta|yüklənmədi')"
