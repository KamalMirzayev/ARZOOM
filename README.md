# Arzoom Avto: onlayn lizinq müraciəti

Müştəri səhifəsi + Node.js API + PostgreSQL. Docker Compose ilə işləyir, GitHub Actions hər `main` push-unda yoxlayır və serverə yerləşdirir.

## Nə var
| Hissə | Fayl |
|---|---|
| Müştəri səhifəsi | `public/index.html` |
| Əməkdaş paneli (qiymətləndirmə) | `public/admin.html`, ünvan: `/admin` |
| Skorinq qaydaları | `lib/scoring.js` |
| SMS göndərişi | `lib/sms.js` |
| API | `server.js` |
| Verilənlər bazası sxemi | `db/schema.sql` (tətbiq açılanda avtomatik yaradılır) |
| Konteynerlər | `Dockerfile`, `docker-compose.yml` |
| HTTPS | `Caddyfile` |
| CI/CD | `.github/workflows/deploy.yml` |
| Server skriptləri | `deploy/bootstrap.sh`, `deploy/deploy.sh`, `deploy/harden.sh` |
| Tam axın testi | `scripts/smoke.sh` |

PostgreSQL internetə açılmır, ona yalnız tətbiq konteyneri qoşulur. Sayt Caddy vasitəsilə HTTPS ilə açılır: domen olanda Let's Encrypt sertifikatı avtomatik alınır və yenilənir, HTTP sorğuları HTTPS-ə yönləndirilir. Yüklənən sənədlər `uploads` volume-unda saxlanılır.

## API
| Metod | Yol | Nə edir |
|---|---|---|
| GET | `/api/health` | Tətbiq və baza işləyirmi |
| POST | `/api/otp` | SMS kodu yaradır (`DEMO_SMS=true` olanda kod cavabda qaytarılır) |
| POST | `/api/applications` | Müraciəti və sənədləri saxlayır, SMS kodunu yoxlayır |
| GET | `/api/applications/:id?fin=` | Müştəri öz müraciətinin statusunu görür |
| POST | `/api/applications/:id/cancel` | Müraciəti ləğv edir |
| POST | `/api/applications/:id/decision` | Təklifi qəbul edir və ya imtina edir |
| GET | `/api/admin/stats` | Panel statistikası |
| GET | `/api/admin/applications?status=&q=` | Müraciətlər (başlıq: `x-admin-token`) |
| GET | `/api/admin/applications/:id` | Müraciət, sənədlər, tarixçə |
| PUT | `/api/admin/applications/:id/assessment` | AKB və gəlir məlumatlarını saxlayır, skoru serverdə hesablayır |
| POST | `/api/admin/applications/:id/offer` | Təklif göndərir: `{"price":62900,"downPct":20,"months":36,"rate":17,"commissionPct":1.5}` |
| POST | `/api/admin/applications/:id/reject` | Rədd edir: `{"reason":"..."}` (səbəb müştəriyə göstərilmir) |
| POST | `/api/admin/applications/:id/notes` | Tarixçəyə qeyd əlavə edir |
| GET | `/api/admin/files/:stored_name` | Yüklənmiş sənədi açır |

## Serverə bir əmrlə quraşdırma
Serverə SSH ilə daxil ol və işə sal (parolları özününkü ilə əvəz et):
```bash
curl -fsSL https://raw.githubusercontent.com/KamalMirzayev/ARZOOM/main/deploy/install.sh \
  | sudo NEW_POSTGRES_PASSWORD='PAROL' NEW_ADMIN_TOKEN='PANEL_ACARI' bash
```
Docker, firewall, PostgreSQL, HTTPS və tətbiq qurulur. Yeniləmək üçün eyni əmri təkrar işlət. Domen olanda `DOMAIN='lizinq.arzoom.az'` də əlavə et.

## CI/CD qurulması (bir dəfə)
1. GitHub-da boş repo yarat və bu qovluğu ora push et.
2. Serverdə deploy üçün SSH açarı əlavə et (parol yox):
   ```bash
   ssh-keygen -t ed25519 -f arzoom_deploy -N ""
   ssh-copy-id -i arzoom_deploy.pub USER@SERVER_IP
   ```
3. Repo → Settings → Secrets and variables → Actions bölməsində əlavə et:
   - `SSH_HOST`: serverin IP ünvanı
   - `SSH_USER`: istifadəçi adı (root və ya sudo icazəsi olan)
   - `SSH_KEY`: `arzoom_deploy` faylının məzmunu (gizli açar)
   - `SSH_PORT`: 22 deyilsə
   - `DOMAIN`: sayt domeni, məs. `lizinq.arzoom.az` (yoxdursa, IP ünvanı istifadə olunur)
   - Açar əvəzinə müvəqqəti olaraq `SSH_PASSWORD` da işləyir, amma açar daha təhlükəsizdir.
   - `POSTGRES_PASSWORD` və `ADMIN_TOKEN` (istəyə bağlı): öz parollarını qoymaq üçün. Yazılmasa, server təsadüfi parol yaradır. Dəyişdirilsə, növbəti deploy-da baza parolu da yenilənir.
4. `main`-ə push et. İlk dəfə `bootstrap.sh` Docker quraşdırır və `/opt/arzoom/.env` faylını təsadüfi parollarla yaradır.

`ADMIN_TOKEN` serverdə `/opt/arzoom/.env` faylındadır.

## Lokal işə salmaq
```bash
cp .env.example .env   # dəyərləri dəyiş
docker compose up -d --build
# https://localhost
```

## Əməkdaş paneli
`https://DOMEN/admin` ünvanında açılır. Giriş üçün ad və `.env`-dəki `ADMIN_TOKEN` lazımdır; hər addım əməkdaşın adı ilə tarixçəyə yazılır.

Axın: müraciəti aç → sənədlərə bax → AKB hesabatından gecikmələri və aylıq borcları, sənədlərdən xalis gəliri və stajı yaz → qiymət və şərtləri daxil et → skor və borc yükü canlı hesablanır → "Təklifi müştəriyə göndər" və ya səbəb yazıb "Müraciəti rədd et". Müştəri nəticəni "Müraciətlərim" bölməsində görür, SMS qoşulubsa, bildiriş də gedir.

Skorinq (tövsiyədir, qərarı əməkdaş verir): borc yükü (DTI) 50%-ə qədər normal, 60%-dən yuxarı imtina; aktiv gecikmə və ya 90+ gün gecikmə dayandırıcıdır; staj, aktiv kredit sayı və ilkin ödəniş balı dəyişir. A ≥ 80, B ≥ 65, C ≥ 50, qalanı D. Həddləri `lib/scoring.js`-də `POLICY` hissəsində dəyiş.

## SMS provayderini qoşmaq
`/opt/arzoom/.env` faylına provayderin ünvanını yaz, `{phone}` və `{text}` avtomatik doldurulur:
```bash
SMS_URL=https://sms.provider.az/send?login=LOGIN&key=KEY&msisdn={phone}&text={text}
# POST tələb edən provayder üçün:
# SMS_METHOD=POST
# SMS_BODY={"to":"{phone}","message":"{text}"}
# SMS_HEADERS={"Authorization":"Bearer TOKEN","Content-Type":"application/json"}
```
Sonra `cd /opt/arzoom && docker compose up -d`. `SMS_URL` olan kimi demo rejimi öz-özünə sönür.

## Domen
1. DNS-də `A` qeydi: `lizinq.arzoom.az → 91.107.161.76`.
2. GitHub secrets-ə `DOMAIN=lizinq.arzoom.az` əlavə et və workflow-u yenidən işə sal (və ya serverdə `.env`-də `SITE_ADDRESS` yaz).
3. Caddy sertifikatı bir neçə saniyəyə alır, sonra hər şey `https://` ilə açılır.

## Təhlükəsizlik
- Server: `ufw` (yalnız SSH, 80, 443), `fail2ban` (SSH-a parol təxmini), avtomatik təhlükəsizlik yeniləmələri.
- PostgreSQL yalnız daxili Docker şəbəkəsindədir, internetə çıxışı da yoxdur.
- Tətbiq konteyneri read-only fayl sistemi ilə, imtiyazsız istifadəçi kimi işləyir.
- Limitlər: SMS kodu 15 dəqiqədə 6, müraciət saatda 10, panelə 15 dəqiqədə 10 uğursuz giriş (IP üzrə).
- Yüklənən fayllar məzmununa görə yoxlanılır: yalnız PDF, JPG, PNG, WEBP, HEIC.
- HTTPS, HSTS, CSP, clickjacking qorunması. Panel `ADMIN_ALLOW` ilə ofis IP-lərinə bağlana bilər.
- Gündəlik baza nüsxəsi: `/opt/arzoom/backups`, 14 gün saxlanılır. Bərpa: `gunzip -c FAYL | docker compose exec -T db psql -U arzoom arzoom`.
- SSH açarı qurulandan sonra parolla girişi bağla: `/etc/ssh/sshd_config`-də `PasswordAuthentication no`, sonra `systemctl restart ssh`.

## Real istifadədən əvvəl
- SMS provayderini qoşmaq (yuxarıda).
- Domeni qoşmaq (yuxarıda).
- Razılıq mətnlərini və skorinq həddlərini hüquqşünas və risk bölməsi ilə təsdiqləmək.
- Hər əməkdaş üçün ayrıca giriş (indi ortaq açar və ad ilə işləyir).
- AKB və ASAN Finans ilə API inteqrasiyası (indi əməkdaş hesabat məlumatlarını əl ilə daxil edir).
