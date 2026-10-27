# Arzoom Avto: onlayn lizinq müraciəti

Müştəri səhifəsi + Node.js API + PostgreSQL. Docker Compose ilə işləyir, GitHub Actions hər `main` push-unda yoxlayır və serverə yerləşdirir.

## Nə var
| Hissə | Fayl |
|---|---|
| Müştəri səhifəsi | `public/index.html` |
| API | `server.js` |
| Verilənlər bazası sxemi | `db/schema.sql` (tətbiq açılanda avtomatik yaradılır) |
| Konteynerlər | `Dockerfile`, `docker-compose.yml` |
| CI/CD | `.github/workflows/deploy.yml` |
| Server skriptləri | `deploy/bootstrap.sh`, `deploy/deploy.sh` |

PostgreSQL internetə açılmır, ona yalnız tətbiq konteyneri qoşulur. Yüklənən sənədlər `uploads` volume-unda saxlanılır.

## API
| Metod | Yol | Nə edir |
|---|---|---|
| GET | `/api/health` | Tətbiq və baza işləyirmi |
| POST | `/api/otp` | SMS kodu yaradır (`DEMO_SMS=true` olanda kod cavabda qaytarılır) |
| POST | `/api/applications` | Müraciəti və sənədləri saxlayır, SMS kodunu yoxlayır |
| GET | `/api/applications/:id?fin=` | Müştəri öz müraciətinin statusunu görür |
| POST | `/api/applications/:id/cancel` | Müraciəti ləğv edir |
| POST | `/api/applications/:id/decision` | Təklifi qəbul edir və ya imtina edir |
| GET | `/api/admin/applications` | Bütün müraciətlər (başlıq: `x-admin-token`) |
| POST | `/api/admin/applications/:id/offer` | Təklif göndərir: `{"price":62900,"downPct":20,"months":36,"rate":17}` |
| GET | `/api/admin/files/:stored_name` | Yüklənmiş sənədi açır |

## CI/CD qurulması (bir dəfə)
1. GitHub-da boş repo yarat və bu qovluğu ora push et.
2. Serverdə deploy üçün SSH açarı əlavə et (parol yox):
   ```bash
   ssh-keygen -t ed25519 -f arzoom_deploy -N ""
   ssh-copy-id -i arzoom_deploy.pub USER@SERVER_IP
   ```
3. Repo → Settings → Secrets and variables → Actions bölməsində əlavə et:
   - `SSH_HOST`: serverin IP ünvanı
   - `SSH_USER`: istifadəçi adı (sudo icazəsi olmalıdır)
   - `SSH_KEY`: `arzoom_deploy` faylının məzmunu (gizli açar)
   - `SSH_PORT`: 22 deyilsə
4. `main`-ə push et. İlk dəfə `bootstrap.sh` Docker quraşdırır və `/opt/arzoom/.env` faylını təsadüfi parollarla yaradır.

`ADMIN_TOKEN` serverdə `/opt/arzoom/.env` faylındadır.

## Lokal işə salmaq
```bash
cp .env.example .env   # dəyərləri dəyiş
docker compose up -d --build
# http://localhost
```

## Real istifadədən əvvəl
- SMS provayderini `server.js`-dəki `TODO` yerinə qoşmaq və `DEMO_SMS=false` etmək.
- Domen və HTTPS (məsələn, Caddy və ya Nginx + Let's Encrypt).
- Razılıq mətnlərini hüquqşünasa yoxlatmaq.
- Əməkdaşlar üçün müraciət paneli (indi yalnız admin API var).
