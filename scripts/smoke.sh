#!/usr/bin/env bash
# API-nin tam axını: OTP → müraciət → qiymətləndirmə → təklif → müştəri qəbulu, və rədd axını.
set -euo pipefail
B=${BASE_URL:-http://localhost:3000}
T=${ADMIN_TOKEN:?ADMIN_TOKEN lazımdır}
J() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval("o."+process.argv[1]))})' "$1"; }
fail() { echo "✗ yoxlama alınmadı, sətir ${BASH_LINENO[0]}"; exit 1; }
# İlk admin: istifadəçi adı admin, parol ADMIN_TOKEN
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d '{"username":"admin","password":"yanlis-parol-123"}')" = 401 ] || { echo "✗ yanlış parol qəbul edildi"; exit 1; }
S=$(curl -fsS -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"$T\"}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
H=(-H "x-admin-token: $S" -H "Content-Type: application/json")
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
SU="satis$RANDOM"
curl -fsS -X POST "${H[@]}" "$B/api/admin/users" -d "{\"username\":\"$SU\",\"name\":\"Test Satış\",\"password\":\"Satis-Parol-12\",\"role\":\"sales\",\"phone\":\"50 111 22 33\"}" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/users" -d '{"username":"badphone","name":"X","password":"Satis-Parol-12","phone":"123"}')" = 400 ] || fail
curl -fsS -X POST "$B/api/applications/$ID/decision" -H "x-app-token: $TOK" -H "Content-Type: application/json" -d '{"decision":"accepted","downPct":30}' >/dev/null
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J offer.final.downPct)" = 30 ] || fail; echo "✓ ilkin ödəniş 30%-ə artırıldı"
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J status)" = accepted ] || fail; echo "✓ təklif qəbul edildi"
sleep 1
EV=$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID")
echo "$EV" | grep -c "Test Satış" >/dev/null && echo "$EV" | grep -c "Müraciət № $ID satışa" >/dev/null && echo "$EV" | grep -c "Son təklifi təsdiqlədiniz" >/dev/null || fail; echo "✓ son təklif SMS-i müştəriyə və satışa"
SS=$(curl -fsS -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d "{\"username\":\"$SU\",\"password\":\"Satis-Parol-12\"}" | J token)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-admin-token: $SS" -H "Content-Type: application/json" "$B/api/admin/applications/$ID2/reject" -d '{"reason":"x"}')" = 403 ] || fail; echo "✓ satış mütəxəssisi qərar verə bilmir"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $SS" "$B/api/admin/analytics")" = 403 ] || fail
curl -fsS "${H[@]}" "$B/api/admin/analytics?days=30" | grep -c '"daily"' >/dev/null || fail; echo "✓ analitika: admin görür, satış görmür"
AK=$(curl -fsS -X POST -H "x-admin-token: $S" -H "Content-Type: text/xml" --data-binary @"$(dirname "$0")/../test/akb-sample.xml" "$B/api/admin/applications/$ID/bureau")
[ "$(echo "$AK" | J report.summary.debtMonthly)" = 500 ] && [ "$(echo "$AK" | J assessment.inputs.maxOverdue)" = "1-30" ] || fail
echo "$AK" | J assessment.result.grade | grep -qE '^[ABCD]$' || fail; echo "✓ AKB XML oxundu və avtomatik hesablandı: $(echo "$AK" | J assessment.result.score) $(echo "$AK" | J assessment.result.grade)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-admin-token: $S" -H "Content-Type: text/xml" -d '<foo/>' "$B/api/admin/applications/$ID/bureau")" = 400 ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: text/xml" -d '<foo/>' "$B/api/integrations/akb")" != 200 ] || fail; echo "✓ yanlış XML və açarsız inteqrasiya rədd edilir"

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
# İstifadəçilər: admin ekspert yaradır, ekspert istifadəçiləri idarə edə bilmir
U="ekspert$RANDOM"
curl -fsS -X POST "${H[@]}" "$B/api/admin/users" -d "{\"username\":\"$U\",\"name\":\"Test Ekspert\",\"password\":\"Ekspert-Parol-1\",\"role\":\"expert\"}" >/dev/null
ES=$(curl -fsS -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d "{\"username\":\"$U\",\"password\":\"Ekspert-Parol-1\"}" | J token)
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $ES" "$B/api/admin/users")" = 403 ] || fail
curl -fsS -H "x-admin-token: $ES" "$B/api/admin/stats" >/dev/null || fail; echo "✓ ekspert hesabı: panel var, istifadəçi idarəsi yox"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "x-admin-token: $ES" -H "Content-Type: application/json" "$B/api/admin/applications/$ID2" -d '{"reason":"test"}')" = 403 ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${H[@]}" "$B/api/admin/applications/$ID2" -d '{}')" = 400 ] || fail
curl -fsS -X DELETE "${H[@]}" "$B/api/admin/applications/$ID2" -d '{"reason":"smoke test"}' >/dev/null || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" "$B/api/admin/applications/$ID2")" = 404 ] || fail; echo "✓ müraciəti yalnız admin silə bilir"
UID_E=$(curl -fsS "${H[@]}" "$B/api/admin/users" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).users.find(u=>u.username===process.argv[1]).id))' "$U")
curl -fsS -X POST "${H[@]}" "$B/api/admin/users/$UID_E" -d '{"permissions":["apps.view","apps.notes"]}' >/dev/null || fail
ES=$(curl -fsS -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d "{\"username\":\"$U\",\"password\":\"Ekspert-Parol-1\"}" | J token)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "x-admin-token: $ES" -H "Content-Type: application/json" "$B/api/admin/applications/$ID/assessment" -d '{}')" = 403 ] || fail
curl -fsS -H "x-admin-token: $ES" "$B/api/admin/me" | grep -c '"apps.notes"' >/dev/null || fail; echo "✓ fərdi icazələr: qiymətləndirmə bağlandı"
curl -fsS -X POST -H "x-admin-token: $ES" "$B/api/admin/logout" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $ES" "$B/api/admin/stats")" = 401 ] || fail; echo "✓ çıxışdan sonra sessiya bağlanır"
echo "Bütün yoxlamalar keçdi."
