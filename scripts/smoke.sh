#!/usr/bin/env bash
# API-nin tam axını: OTP → müraciət → qiymətləndirmə → təklif → müştəri qəbulu, və rədd axını.
set -euo pipefail
B=${BASE_URL:-http://localhost:3000}
T=${ADMIN_TOKEN:?ADMIN_TOKEN lazımdır}
J() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval("o."+process.argv[1]))})' "$1"; }
fail() { echo "✗ yoxlama alınmadı, sətir ${BASH_LINENO[0]}"; exit 1; }
H=(-H "x-admin-token: $T" -H "x-staff-name: CI" -H "Content-Type: application/json")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMP/arayis.pdf"
echo '<script>alert(1)</script>' > "$TMP/fake.pdf"

curl -fsS "$B/api/health" | grep -c '"ok":true' >/dev/null
curl -fsS "$B/" | grep -c "Arzoom Avto Lizinq" >/dev/null
curl -fsS "$B/admin" | grep -c "Qiymətləndirmə" >/dev/null
curl -fsS "$B/admin/scoring.js" | grep -c "assess" >/dev/null
echo "✓ səhifələr"

apply() { # $1 phone, $2 file
  local code; code=$(curl -fsS -X POST "$B/api/otp" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | J demoCode)
  curl -sS -X POST "$B/api/applications" -F fin=5ABC12D -F idSeries=AZE -F idNumber=12345678 -F phone="$1" \
    -F incomeSources=work,biz -F voen=1234567890 -F brand=Toyota -F model=Camry -F consent=true -F consentText=ok \
    -F otp="$code" -F "file_work=@$2;type=application/pdf"
}
R=$(apply 994501112233 "$TMP/fake.pdf"); echo "$R" | grep -c "PDF və ya şəkil deyil" >/dev/null || fail; echo "✓ saxta fayl rədd edildi"
R=$(apply 994501112234 "$TMP/arayis.pdf"); ID=$(echo "$R" | J id); TOK=$(echo "$R" | J token); echo "✓ müraciət $ID"
R2=$(apply 994501112235 "$TMP/arayis.pdf"); ID2=$(echo "$R2" | J id); TOK2=$(echo "$R2" | J token)

[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-admin-token: wrong-token-xxxxxxxx' "$B/api/admin/applications")" = 401 ] || fail; echo "✓ yanlış açar 401"
curl -fsS "${H[@]}" "$B/api/admin/applications?status=review" | grep -c "$ID" >/dev/null || fail
STORED=$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | J 'files[0].stored_name')
curl -fsS "${H[@]}" "$B/api/admin/files/$STORED" -o "$TMP/dl" && head -c 5 "$TMP/dl" | grep -q "%PDF" || fail; echo "✓ sənəd açılır"

A=$(curl -fsS -X PUT "${H[@]}" "$B/api/admin/applications/$ID/assessment" \
  -d '{"incomeMonthly":3000,"debtMonthly":200,"activeLoans":1,"maxOverdue":"0","tenureMonths":30,"docsOk":true,"price":45000,"downPct":20,"months":36,"rate":17}')
[ "$(echo "$A" | J result.verdict)" = approve ] || fail; echo "✓ skor: $(echo "$A" | J result.score) $(echo "$A" | J result.grade)"
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID/offer" -d '{"price":45000,"downPct":20,"months":36,"rate":17,"commissionPct":1.5}' >/dev/null
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J status)" = offer ] || fail; echo "✓ müştəri təklifi görür"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/applications/$ID/decision" -H "Content-Type: application/json" -d '{"decision":"accepted"}')" = 401 ] || fail; echo "✓ açarsız qərar 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/applications/$ID/decision" -H "x-app-token: $TOK" -H "Content-Type: application/json" -d '{"decision":"accepted","downPct":10}')" = 400 ] || fail; echo "✓ ilkin ödəniş azaldıla bilmir"
curl -fsS -X POST "$B/api/applications/$ID/decision" -H "x-app-token: $TOK" -H "Content-Type: application/json" -d '{"decision":"accepted","downPct":30}' >/dev/null
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J offer.final.downPct)" = 30 ] || fail; echo "✓ ilkin ödəniş 30%-ə artırıldı"
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J status)" = accepted ] || fail; echo "✓ təklif qəbul edildi"

curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/reject" -d '{"reason":"DTI 70%"}' >/dev/null
[ "$(curl -fsS -H "x-app-token: $TOK2" "$B/api/applications/$ID2" | J status)" = rejected ] || fail; echo "✓ rədd axını"
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/notes" -d '{"text":"zəng edildi"}' >/dev/null
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID2" | J 'events.length')" -ge 3 ] || fail; echo "✓ tarixçə"
curl -fsS "${H[@]}" "$B/api/admin/stats" | grep -c '"accepted"' >/dev/null || fail; echo "✓ statistika"
# Başqa cihazdan: nömrə + FİN + SMS kodu
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/lookup/otp" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"0000000\"}")" = 404 ] || fail; echo "✓ yanlış FİN tapılmır"
L=$(curl -fsS -X POST "$B/api/lookup/otp" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"5abc12d\"}")
echo "$L" | grep -c '\*\*\*' >/dev/null || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/lookup/verify" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"5ABC12D\",\"code\":\"000000\"}")" = 401 ] || fail; echo "✓ yanlış kod 401"
V=$(curl -fsS -X POST "$B/api/lookup/verify" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"5ABC12D\",\"code\":\"$(echo "$L" | J demoCode)\"}")
NT=$(echo "$V" | J token); [ "$(echo "$V" | J application.status)" = rejected ] || fail
[ "$(curl -fsS -H "x-app-token: $NT" "$B/api/applications/$ID2" | J id)" = "$ID2" ] || fail; echo "✓ nömrə + FİN + SMS ilə giriş"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-app-token: $NT" "$B/api/applications/$ID")" = 401 ] || fail; echo "✓ açar yalnız öz müraciətini açır"
echo "Bütün yoxlamalar keçdi."
