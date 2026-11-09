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
curl -fsS "$B/" | grep -c "Yeni avtomobiliniz, bir müraciət məsafəsində" >/dev/null
curl -fsS "$B/admin" | grep -c "Qiymətləndirmə" >/dev/null
curl -fsS "$B/admin/scoring.js" | grep -c "assess" >/dev/null
echo "✓ səhifələr"

# There is no test code in the app: SMS codes are random and only sent by SMS. The test writes a code
# straight into otp_codes, hashed the way the server hashes it (needs the server's DATABASE_URL and OTP_SECRET).
seed() { # $1 phone, $2 code
  node -e 'const c=require("crypto"),{Client}=require("pg");const [p,k]=process.argv.slice(1);
    const h=c.createHmac("sha256",process.env.OTP_SECRET).update(p+":"+k).digest("hex"),db=new Client({connectionString:process.env.DATABASE_URL});
    db.connect().then(()=>db.query("INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '"'"'5 minutes'"'"', 0) ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0",[p,h])).then(()=>db.end())' "$1" "$2"
}
: "${OTP_SECRET:?OTP_SECRET lazımdır}" "${DATABASE_URL:?DATABASE_URL lazımdır}"
SMS_ON=$(curl -fsS "$B/api/health" | J sms)
if [ "$SMS_ON" = false ]; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/otp" -H "Content-Type: application/json" -d '{"phone":"994501112233"}')" = 503 ] || fail; echo "✓ SMS provayderi yoxdursa kod verilmir (sınaq kodu yoxdur)"
fi
apply() { # $1 phone, $2 file
  local code; code=$(printf "%06d" $((RANDOM * RANDOM % 1000000))); seed "$1" "$code"
  curl -sS -X POST "$B/api/applications" -F fin=5ABC12D -F idSeries=AZE -F idNumber=12345678 -F birthDate=1990-05-17 -F phone="$1" \
    -F incomeSources=work,biz -F voen=1234567890 -F brand=Toyota -F model=Camry -F consent=true -F consentText=ok \
    -F guarantor=yes -F otp="$code" -F partner=groupmotors -F partnerRef=111938 -F "file_work=@$2;type=application/pdf" -F "file_biz=@$2;type=application/pdf"
}
# A sales manager with a phone gets the new-application SMS.
SU="satis$RANDOM"
curl -fsS -X POST "${H[@]}" "$B/api/admin/users" -d "{\"username\":\"$SU\",\"name\":\"Test Satış\",\"password\":\"Satis-Parol-12\",\"role\":\"sales\",\"phone\":\"50 111 22 33\"}" >/dev/null
BU="byd$RANDOM"
curl -fsS -X POST "${H[@]}" "$B/api/admin/users" -d "{\"username\":\"$BU\",\"name\":\"Test BYD\",\"password\":\"Satis-Parol-12\",\"role\":\"sales\",\"phone\":\"50 111 22 44\",\"brands\":[\"BYD\"]}" >/dev/null
R=$(apply 994501112233 "$TMP/fake.pdf"); echo "$R" | grep -c "PDF və ya şəkil deyil" >/dev/null || fail; echo "✓ saxta fayl rədd edildi"
R=$(apply 994501112234 "$TMP/arayis.pdf"); ID=$(echo "$R" | J id); TOK=$(echo "$R" | J token); echo "✓ müraciət $ID"
R2=$(apply 994501112235 "$TMP/arayis.pdf"); ID2=$(echo "$R2" | J id); TOK2=$(echo "$R2" | J token)

[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-admin-token: wrong-token-xxxxxxxx' "$B/api/admin/applications")" = 401 ] || fail; echo "✓ yanlış açar 401"
curl -fsS "${H[@]}" "$B/api/admin/applications?status=review" | grep -c "$ID" >/dev/null || fail
# Period: today's list has the new application, yesterday's does not, a search finds it whatever the period
curl -fsS "${H[@]}" "$B/api/admin/applications?period=today" | grep -q "\"id\":\"$ID\"" || fail
curl -fsS "${H[@]}" "$B/api/admin/applications?period=yesterday" | grep -q "\"id\":\"$ID\"" && fail
curl -fsS "${H[@]}" "$B/api/admin/applications?period=yesterday&q=$ID" | grep -q "\"id\":\"$ID\"" || fail
echo "✓ siyahı günə görə: bu gün, dünən; axtarış bütün tarixlərdə"
STORED=$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | J 'files[0].stored_name')
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | J birth_date)" = 1990-05-17 ] || fail; echo "✓ doğum tarixi saxlanılır"
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | J guarantor)" = true ] || fail; echo "✓ zamin cavabı saxlanılır"
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | J partner_ref)" = 111938 ] && curl -fsS "${H[@]}" "$B/api/admin/applications?q=111938" | grep -q "$ID" || fail; echo "✓ partnyor ref nömrəsi saxlanılır və axtarılır"
sleep 1; curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | grep -q "Yeni müraciət № $ID" || fail; echo "✓ yeni müraciət SMS-i menecerə və risk ekspertinə"
curl -fsS "${H[@]}" "$B/api/admin/files/$STORED" -o "$TMP/dl" && head -c 5 "$TMP/dl" | grep -q "%PDF" || fail; echo "✓ sənəd açılır"

A=$(curl -fsS -X PUT "${H[@]}" "$B/api/admin/applications/$ID/assessment" \
  -d '{"incomeMonthly":3000,"debtMonthly":200,"activeLoans":1,"maxOverdue":"0","tenureMonths":30,"docsOk":true,"price":45000,"downPct":20,"months":36,"rate":17}')
[ "$(echo "$A" | J result.verdict)" = approve ] || fail; echo "✓ skor: $(echo "$A" | J result.score) $(echo "$A" | J result.grade)"
# Partner webhook: the final result goes to the partner with its ref number and X-Api-Key; the address and token never come back.
WHF="$TMP/webhook.txt"
node -e 'const fs=require("fs");require("http").createServer((q,r)=>{const u=new URL(q.url,"http://x");if(q.method==="GET"&&u.pathname==="/credit/kb/wh-token-12345"){const c=JSON.parse(fs.readFileSync(process.argv[2])).chunks,b=u.searchParams.get("brand");return r.end(JSON.stringify({chunks:b?c.filter(x=>x.brand===b):c.slice(0,2)}))}let b="";q.on("data",c=>b+=c);q.on("end",()=>{fs.appendFileSync(process.argv[1],q.headers["x-api-key"]+" "+b+"\n");r.end("ok")})}).listen(13999)' "$WHF" "$(pwd)/test/stock-sample.json" &
WHPID=$!; sleep 1
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/settings/webhook" -d '{"url":"http://example.com/x"}')" = 400 ] || fail
curl -fsS -X POST "${H[@]}" "$B/api/admin/settings/webhook" -d '{"url":"http://127.0.0.1:13999/hook/secret-path-123","token":"wh-token-12345"}' | grep -q '"connected":true' || fail
curl -fsS "${H[@]}" "$B/api/admin/settings/webhook" | grep -q "secret-path-123\|wh-token-12345" && fail
# Partner stock: price lists from the same partner become models with trims and prices; FAQ chunks are ignored.
ST=$(curl -fsS "$B/api/stock")
echo "$ST" | grep -q '"name":"Seal 6 DM-i 128km Active (2026)","year":2026,"price":38300' && ! echo "$ST" | grep -q "Zəmanət" || fail
echo "$ST" | grep -q '"name":"Land Cruiser LC300 3.3 DSL 10AT AX 5 seater (AB)","year":null,"price":189900' && echo "$ST" | grep -q '"name":"Land Cruiser LC300 3.3 DSL 10AT VX 5 seater (EJ)","year":null,"price":null' \
  && echo "$ST" | grep -q '"name":"Pajero Sport 2.4L GLS HIGH Dizel","year":null,"price":89900' || fail
curl -fsS "${H[@]}" "$B/api/admin/settings/webhook" | grep -q '"count":22' || fail; echo "✓ partnyor stoku: qiymət siyahısı və texniki göstəricilərdən bütün modellər, komplektasiyalar və qiymətlər"
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID/offer" -d '{"price":45000,"downPct":20,"months":36,"rate":17,"commissionPct":1.5}' >/dev/null
sleep 1; grep -q '^wh-token-12345 {"event":"approved","external_id":"111938","application_id":"'"$ID"'"' "$WHF" && grep -q '"amount":36000' "$WHF" || fail
grep -qi '"fin"\|5ABC12D' "$WHF" && fail
echo "✓ partnyor webhook: təsdiq ref nömrəsi və X-Api-Key ilə göndərilir, FİN getmir, ünvan gizlidir"
sleep 1; curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | grep -q "üzrə müştəriyə təklif göndərildi" || fail; echo "✓ təklif SMS-i satış mütəxəssisinə də gedir"
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J status)" = offer ] || fail; echo "✓ müştəri təklifi görür"
curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | grep -q commissionPct && fail; echo "✓ müştəriyə komissiya göndərilmir"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/applications/$ID/decision" -H "Content-Type: application/json" -d '{"decision":"accepted"}')" = 401 ] || fail; echo "✓ açarsız qərar 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/applications/$ID/decision" -H "x-app-token: $TOK" -H "Content-Type: application/json" -d '{"decision":"accepted","downPct":10}')" = 400 ] || fail; echo "✓ ilkin ödəniş azaldıla bilmir"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/users" -d '{"username":"badphone","name":"X","password":"Satis-Parol-12","phone":"123"}')" = 400 ] || fail
curl -fsS -X POST "$B/api/applications/$ID/decision" -H "x-app-token: $TOK" -H "Content-Type: application/json" -d '{"decision":"accepted","downPct":30}' >/dev/null
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J offer.final.downPct)" = 30 ] || fail; echo "✓ ilkin ödəniş 30%-ə artırıldı"
[ "$(curl -fsS -H "x-app-token: $TOK" "$B/api/applications/$ID" | J status)" = accepted ] || fail; echo "✓ təklif qəbul edildi"
sleep 1; grep '^wh-token-12345 {"event":"accepted","external_id":"111938","application_id":"'"$ID"'"' "$WHF" | grep -q '"down_payment_pct":30' || fail; echo "✓ satışa ötürülmə partnyora göndərilir (son şərtlərlə)"
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

# Əlavə məlumat: ekspert istəyir, müştəri kabinetdən mətn və sənədlə cavab verir, müraciət yenidən baxılır
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/applications/$ID2/request-info" -d '{"text":"x"}')" = 400 ] || fail
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/request-info" -d '{"text":"Son 6 ayın əmək haqqı arayışı"}' >/dev/null || fail
[ "$(curl -fsS -H "x-app-token: $TOK2" "$B/api/applications/$ID2" | J status)" = info ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-app-token: $TOK2" "$B/api/applications/$ID2/info")" = 400 ] || fail
curl -fsS -X POST -H "x-app-token: $TOK2" "$B/api/applications/$ID2/info" -F "text=Arayış əlavə edildi" -F "file_extra=@$TMP/arayis.pdf;type=application/pdf" >/dev/null || fail
AI=$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID2")
[ "$(echo "$AI" | J status)" = review ] && echo "$AI" | grep -q '"income_source":"extra"' && echo "$AI" | grep -q "əlavə məlumat lazımdır" || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-app-token: $TOK2" "$B/api/applications/$ID2/info" -F "text=yenə")" = 409 ] || fail; echo "✓ əlavə məlumat: sorğu, müştəri cavabı və sənəd, yenidən baxış"
# Sənəd kombinasiyası: hər tələb olunan sənəd ayrıca yüklənməlidir
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/applications/$ID2/request-info" -d '{"docs":[{"key":"toString"}]}')" = 400 ] || fail
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/request-info" -d '{"docs":[{"key":"mygov_salary"},{"key":"salary_card"}]}' | grep -q '"label":"MyGov-dan rəsmi əmək haqqı arayışı"' || fail
curl -fsS -H "x-app-token: $TOK2" "$B/api/applications/$ID2" | grep -q '"key":"salary_card"' || fail
curl -sS -X POST -H "x-app-token: $TOK2" "$B/api/applications/$ID2/info" -F "file_d0=@$TMP/arayis.pdf;type=application/pdf" | grep -q "Əmək haqqı kart hesabından" || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-app-token: $TOK2" "$B/api/applications/$ID2/info" -F "file_d9=@$TMP/arayis.pdf;type=application/pdf")" = 400 ] || fail
curl -fsS -X POST -H "x-app-token: $TOK2" "$B/api/applications/$ID2/info" -F "file_d0=@$TMP/arayis.pdf;type=application/pdf" -F "file_d1=@$TMP/arayis.pdf;type=application/pdf" >/dev/null || fail
curl -fsS "${H[@]}" "$B/api/admin/applications/$ID2" | grep -q '"doc_label":"Əmək haqqı kart hesabından çıxarış (son 6 ay)"' || fail
echo "✓ əlavə sənəd kombinasiyası: hər sənəd ayrıca, çatışmayan rədd olunur"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/applications/$ID2/reject" -d '{"reason":"DTI 70%"}')" = 400 ] || fail; echo "✓ müştəri səbəbi seçilmədən rədd olmur"
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/reject" -d '{"reason":"DTI 70%","code":"debt"}' >/dev/null
sleep 1; grep -q '^wh-token-12345 {"event":"rejected","external_id":"111938","application_id":"'"$ID2"'","date":"[^"]*","phone":"+994501112235"}$' "$WHF" || fail
# A ref added later by staff: the partner gets "submitted" and then the current result.
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/applications/$ID2/partner-ref" -d '{"ref":"bad ref!"}')" = 400 ] || fail
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/partner-ref" -d '{"ref":"222333"}' | grep -q '"partner_ref":"222333"' || fail
sleep 1; grep -q '^wh-token-12345 {"event":"submitted","external_id":"222333","application_id":"'"$ID2"'"' "$WHF" \
  && grep -q '^wh-token-12345 {"event":"rejected","external_id":"222333","application_id":"'"$ID2"'"' "$WHF" || fail
echo "✓ sonradan əlavə edilən ref partnyora göndərilir"
curl -fsS -X POST "${H[@]}" "$B/api/admin/settings/webhook" -d '{"clear":true}' | grep -q '"connected":false' || fail
kill $WHPID 2>/dev/null; echo "✓ partnyor webhook: rədd bildirişi göndərilir"
R2=$(curl -fsS -H "x-app-token: $TOK2" "$B/api/applications/$ID2")
[ "$(echo "$R2" | J status)" = rejected ] && echo "$R2" | J reject_public | grep -q "borc yükünüz" || fail; echo "✓ rədd axını, müştəri səbəbi görür"
sleep 1; curl -fsS "${H[@]}" "$B/api/admin/applications/$ID2" | grep -q "təsdiqlənmədi. Səbəb: Mövcud kredit" || fail; echo "✓ rədd SMS-ində səbəb var"
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/notes" -d '{"text":"zəng edildi"}' >/dev/null
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$ID2" | J 'events.length')" -ge 3 ] || fail; echo "✓ tarixçə"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/applications/$ID2/notes" -d '{"outcome":"toString"}')" = 400 ] || fail
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$ID2/notes" -d '{"outcome":"verified","channel":"meeting"}' >/dev/null
curl -fsS "${H[@]}" "$B/api/admin/applications?q=$ID2" | grep -q '"last_call":"verified"' || fail; echo "✓ danışığın nəticəsi qeyd olunur və siyahıda görünür"
curl -fsS "${H[@]}" "$B/api/admin/stats" | grep -c '"accepted"' >/dev/null || fail; echo "✓ statistika"
# Başqa cihazdan: nömrə + FİN + SMS kodu
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/lookup/otp" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"0000000\"}")" = 404 ] || fail; echo "✓ yanlış FİN tapılmır"
[ "$SMS_ON" = true ] || [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/lookup/otp" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"5abc12d\"}")" = 503 ] || fail
seed 994501112235 482913
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/lookup/verify" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"5ABC12D\",\"code\":\"000000\"}")" = 401 ] || fail; echo "✓ yanlış kod 401"
V=$(curl -fsS -X POST "$B/api/lookup/verify" -H "Content-Type: application/json" -d "{\"id\":\"$ID2\",\"fin\":\"5ABC12D\",\"code\":\"482913\"}")
NT=$(echo "$V" | J token); [ "$(echo "$V" | J application.status)" = rejected ] || fail
[ "$(curl -fsS -H "x-app-token: $NT" "$B/api/applications/$ID2" | J id)" = "$ID2" ] || fail; echo "✓ nömrə + FİN + SMS ilə giriş"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-app-token: $NT" "$B/api/applications/$ID")" = 401 ] || fail; echo "✓ açar yalnız öz müraciətini açır"
# İstifadəçilər: admin ekspert yaradır, ekspert istifadəçiləri idarə edə bilmir
U="ekspert$RANDOM"
curl -fsS -X POST "${H[@]}" "$B/api/admin/users" -d "{\"username\":\"$U\",\"name\":\"Test Ekspert\",\"password\":\"Ekspert-Parol-1\",\"role\":\"expert\"}" >/dev/null
ES=$(curl -fsS -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d "{\"username\":\"$U\",\"password\":\"Ekspert-Parol-1\"}" | J token)
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $ES" "$B/api/admin/users")" = 403 ] || fail
curl -fsS -H "x-admin-token: $ES" "$B/api/admin/stats" >/dev/null || fail; echo "✓ ekspert hesabı: panel var, istifadəçi idarəsi yox"
# Excel: admin yükləyir (ZIP/xlsx), ekspertin standart icazəsi yoxdur
[ "$(curl -fsS "${H[@]}" "$B/api/admin/export.xlsx" | head -c 2)" = "PK" ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $ES" "$B/api/admin/export.xlsx")" = 403 ] || fail; echo "✓ Excel-ə çıxarış: admin yükləyir, ekspert yox"
# Marka: BYD satış mütəxəssisi Toyota müraciətini görmür və onun SMS-ini almır
BS=$(curl -fsS -X POST "$B/api/admin/login" -H "Content-Type: application/json" -d "{\"username\":\"$BU\",\"password\":\"Satis-Parol-12\"}" | J token)
curl -fsS -H "x-admin-token: $BS" "$B/api/admin/applications?status=" | grep -q "\"$ID\"" && fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $BS" "$B/api/admin/applications/$ID")" = 404 ] || fail
curl -fsS "${H[@]}" "$B/api/admin/applications/$ID" | grep -q "Test BYD" && fail; echo "✓ marka üzrə bölgü: BYD mütəxəssisi Toyota müraciətini görmür, SMS almır"
# SMS ayarı: yalnız admin, açar heç vaxt geri qaytarılmır, natamam forma rədd edilir
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $ES" "$B/api/admin/settings/sms")" = 403 ] || fail
SMSST=$(curl -fsS "${H[@]}" "$B/api/admin/settings/sms"); echo "$SMSST" | grep -q '"keySet"' || fail; echo "$SMSST" | grep -q '"key"' && fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/settings/sms" -d '{"user":""}')" = 400 ] || fail; echo "✓ SMS ayarı: yalnız admin, açar gizli qalır"
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
# Təhlükəsizlik
R=$(curl -sS -X POST "$B/api/applications" -F fin=5ABC12D -F idSeries=AZE -F idNumber=12345678 -F birthDate=1990-05-17 -F phone=994501112299 -F incomeSources=work -F "file_work=@$TMP/arayis.pdf;type=application/pdf" \
  --form-string 'brand=<img src=x onerror=alert(1)>' -F model=Camry -F consent=true -F consentText=ok -F otp=000000)
echo "$R" | grep -c "Avtomobil seçilməyib" >/dev/null || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/applications" -F fin=5ABC12D -F idSeries=toString -F idNumber=1 -F phone=994501112299 -F incomeSources=work -F brand=Toyota -F model=Camry -F consent=true)" = 400 ] || fail
for d in "$(date -d '-17 years' +%F)" 1990-02-30 17.05.1990; do
  curl -sS -X POST "$B/api/applications" -F fin=5ABC12D -F idSeries=AZE -F idNumber=12345678 -F birthDate="$d" -F phone=994501112299 -F incomeSources=work \
    -F brand=Toyota -F model=Camry -F consent=true | grep -q "Doğum tarixi" || fail
done
echo "✓ marka/model və vəsiqə seriyası, doğum tarixi yoxlanılır"
INF=(-F fin=5ABC12D -F idSeries=AZE -F idNumber=12345678 -F birthDate=1990-05-17 -F phone=994501112299 -F incomeSources=informal -F brand=Toyota -F model=Camry -F consent=true -F guarantor=no -F otp=000000)
curl -sS -X POST "$B/api/applications" "${INF[@]}" | grep -q "Qeyri-rəsmi gəlirlər üçün sənəd məcburidir" || fail
# With the statement attached the request passes the document check and stops at the missing guarantor answer.
curl -sS -X POST "$B/api/applications" "${INF[@]/guarantor=no/guarantor=}" -F "file_informal=@$TMP/arayis.pdf;type=application/pdf" | grep -q "Zamin sualına" || fail
echo "✓ qeyri-rəsmi gəlirlər: sənəd məcburidir, zamin sualı cavablanmalıdır"
curl -sSI "$B/admin" | grep -i "^content-security-policy" | grep -q "script-src 'self' 'sha256-" || fail
curl -sSI "$B/admin" | grep -i "^content-security-policy" | grep -vq "script-src[^;]*unsafe-inline" || fail; echo "✓ CSP: inline skript yalnız hash ilə"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/users" -d '{"username":"weakpw","name":"X","password":"aaaaaaaaaaaa"}')" = 400 ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$B/api/admin/users" -d '{"username":"weakpw","name":"X","password":"weakpw-12345"}')" = 400 ] || fail; echo "✓ zəif parol qəbul edilmir"
AU=$(curl -fsS "${H[@]}" "$B/api/admin/audit")
for k in login.fail login file.view user.create app.delete; do echo "$AU" | grep -q "\"action\":\"$k\"" || fail; done
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $SS" "$B/api/admin/audit")" = 403 ] || fail; echo "✓ təhlükəsizlik jurnalı"
# Robocall: token-protected pull of applications, paged; no interest rate, FİN masked, deleted ones flagged
RCU="$B/api/integrations/robocall/applications"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$RCU")" = 401 ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-admin-token: $SS" -H "Content-Type: application/json" "$B/api/admin/settings/robocall" -d '{}')" = 403 ] || fail
RCT=$(curl -fsS -X POST "${H[@]}" "$B/api/admin/settings/robocall" -d '{}' | grep -o '"token":"rc_[A-Za-z0-9_-]*"' | cut -d'"' -f4)
[ -n "$RCT" ] || fail
curl -fsS "${H[@]}" "$B/api/admin/settings/robocall" | grep -q '"token"' && fail
RC1=$(curl -fsS -H "x-integration-token: $RCT" "$RCU?limit=1")
echo "$RC1" | grep -q '"has_more":true' || fail
NS=$(echo "$RC1" | grep -o '"next_since":"[^"]*"' | cut -d'"' -f4)
RC2=$(curl -fsS -H "x-integration-token: $RCT" --get --data-urlencode "since=$NS" "$RCU?limit=1")
[ "$(echo "$RC1" | grep -o '"id":"[^"]*"' | head -1)" != "$(echo "$RC2" | grep -o '"id":"[^"]*"' | head -1)" ] || fail
RCA=$(curl -fsS -H "x-integration-token: $RCT" "$RCU?limit=500")
echo "$RCA" | grep -q '"rate"\|interest\|commission\|"fin":' && fail
echo "$RCA" | grep -q "\"id\":\"$ID2\",\"deleted\":true" || fail
echo "$RCA" | grep -q "\"status\":\"accepted\",\"status_label\":\"Satışa ötürülüb\"" || fail
echo "$RCA" | grep -q '"final_terms":{[^}]*"monthly_payment":' || fail
echo "$RCA" | grep -q '"fin_masked":"\*\*\*' || fail
RLIVE=$(echo "$RCA" | grep -o '"id":"[^"]*","deleted":false' | head -1 | cut -d'"' -f4)
FBID="smoke-fb-$(date +%s%N)"
FB='{"feedback_id":"'"$FBID"'","call_ref":"job-1","at":"2026-11-09T10:00:00Z","outcome":"declined","outcome_label":"İmtina etdi","reason":"Başqa yerdən aldı"}'
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d "$FB")" = 401 ] || fail
curl -fsS -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d "$FB" | grep -q '"duplicate":false' || fail
curl -fsS -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d "$FB" | grep -q '"duplicate":true' || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/YOX-0000/feedback" -d "$FB")" = 404 ] || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d '{"feedback_id":"x","outcome":"hack"}')" = 400 ] || fail
curl -fsS -H "x-integration-token: $RCT" "$RCU?limit=500" | grep -q '"last_call":{"outcome":"declined","outcome_label":"İmtina etdi","channel":"robocall","text":"Başqa yerdən aldı"' || fail
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$RLIVE" | grep -o "$FBID" | wc -l)" = 1 ] || fail
# Təkrar təklif: the customer wants a lower monthly payment -> the offer goes back to staff; a new offer moves it on
node -e 'const {Client}=require("pg"),db=new Client({connectionString:process.env.DATABASE_URL});db.connect().then(()=>db.query("UPDATE applications SET status = '"'"'offer'"'"' WHERE id = $1",[process.argv[1]])).then(()=>db.end())' "$RLIVE"
RO='{"feedback_id":"'"$FBID"'-ro","outcome":"wants_lower_monthly","reason":"Aylıq 800-dən çox ola bilməz","requested_terms":{"monthly_payment":800}}'
curl -fsS -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d "$RO" | grep -q '"reoffer":true' || fail
curl -fsS "${H[@]}" "$B/api/admin/applications?status=reoffer" | grep -q "\"id\":\"$RLIVE\"" || fail
curl -fsS "${H[@]}" "$B/api/admin/applications/$RLIVE" | grep -q '"reoffer":{[^}]*"reason":"Aylıq 800-dən çox ola bilməz"' || fail
curl -fsS -H "x-integration-token: $RCT" "$RCU?limit=500" | grep -q '"status":"reoffer","status_label":"Təklif yenidən hazırlanır"' || fail
curl -fsS -X POST "${H[@]}" "$B/api/admin/applications/$RLIVE/offer" -d '{"price":45000,"downPct":20,"months":60,"rate":17,"commissionPct":1.5}' >/dev/null || fail
[ "$(curl -fsS "${H[@]}" "$B/api/admin/applications/$RLIVE" | J status)" = offer ] || fail
curl -fsS -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d '{"feedback_id":"'"$FBID"'-x","outcome":"thinking"}' | grep -q '"reoffer":false' || fail
curl -fsS -X POST -H "x-integration-token: $RCT" -H "Content-Type: application/json" "$RCU/$RLIVE/feedback" -d '{"feedback_id":"'"$FBID"'-ts","outcome":"transferred_to_sales","reason":"Ext 205"}' | grep -q '"ok":true' || fail
echo "✓ təkrar təklif: robocall narazılığı müraciəti geri qaytarır, yeni təklif göndərilir"
curl -fsS -X POST "${H[@]}" "$B/api/admin/settings/robocall" -d '{"clear":true}' >/dev/null || fail
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-integration-token: $RCT" "$RCU")" = 401 ] || fail
echo "✓ robocall inteqrasiyası: token, səhifələmə, faizsiz, silinmişlər, zəng nəticəsi bir dəfə yazılır"
echo "Bütün yoxlamalar keçdi."
