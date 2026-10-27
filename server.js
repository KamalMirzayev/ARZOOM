// Arzoom Avto lizinq: static page + JSON API backed by PostgreSQL.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { Pool } = require("pg");
const { sendSms, configured: SMS_ON } = require("./lib/sms");
const Scoring = require("./lib/scoring");
const { rateLimit } = require("./lib/ratelimit");
const { sniff } = require("./lib/filecheck");

const PORT = +process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// Until an SMS provider is connected (SMS_URL) the code is returned to the page so the flow can be tested.
const DEMO_SMS = !SMS_ON && process.env.DEMO_SMS !== "false";
const SITE_URL = process.env.SITE_ADDRESS && process.env.SITE_ADDRESS !== "localhost" ? `https://${process.env.SITE_ADDRESS}` : "";
const INCOME = ["work", "biz", "pension", "social"];
const SERIES = { AZE: 8, AA: 7, AB: 7 };

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
// Only the Caddy proxy on the private Docker network is trusted for X-Forwarded-For.
app.set("trust proxy", "loopback, uniquelocal");
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: false // Caddy sets HSTS on HTTPS responses
}));
app.use((req, res, next) => { if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store"); next(); });
app.use(express.json({ limit: "100kb" }));

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const normPhone = p => String(p || "").replace(/\D/g, "");
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const logEvent = (db, id, actor, kind, details = null) =>
  db.query("INSERT INTO application_events (application_id, actor, kind, details) VALUES ($1,$2,$3,$4)", [id, actor, kind, details]);
// Customer notifications must never break the staff action that triggered them.
async function notify(id, phone, text) {
  if (!SMS_ON) return;
  try { await sendSms(phone, text); await logEvent(pool, id, "Sistem", "sms", { text }); }
  catch (e) { console.error(e.message); await logEvent(pool, id, "Sistem", "sms", { text, error: e.message }).catch(() => {}); }
}

/* ---------- health ---------- */
app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, demoSms: DEMO_SMS }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

/* ---------- OTP ---------- */
const otpLimit = rateLimit({ windowMs: 15 * 60e3, max: 6 });
const submitLimit = rateLimit({ windowMs: 60 * 60e3, max: 10 });
const lookupLimit = rateLimit({ windowMs: 60e3, max: 60 });
const adminFail = rateLimit({ windowMs: 15 * 60e3, max: 10, message: "Çox sayda uğursuz giriş. 15 dəqiqə sonra yenidən cəhd et." });

app.post("/api/otp", otpLimit, async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!/^994\d{9}$/.test(phone)) return bad(res, "Mobil nömrə düzgün deyil.");
  const prev = await pool.query("SELECT 1 FROM otp_codes WHERE phone = $1 AND expires_at > now() + interval '4 minutes'", [phone]);
  if (prev.rowCount) return bad(res, "Kod artıq göndərilib. Yenisini 1 dəqiqədən sonra istəyə bilərsən.", 429);
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '5 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [phone, sha(phone + code)]
  );
  if (SMS_ON) {
    try { await sendSms(phone, `Arzoom Avto: təsdiq kodunuz ${code}. Kod 5 dəqiqə etibarlıdır.`); }
    catch (e) { console.error(e.message); await pool.query("DELETE FROM otp_codes WHERE phone = $1", [phone]); return bad(res, "SMS göndərilmədi. Bir az sonra yenidən cəhd et.", 502); }
  }
  res.json({ sent: true, ...(DEMO_SMS ? { demoCode: code } : {}) });
});

async function checkOtp(phone, code) {
  const { rows } = await pool.query("SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone = $1", [phone]);
  const r = rows[0];
  if (!r || r.expires_at < new Date() || r.attempts >= 5) return false;
  if (r.code_hash !== sha(phone + code)) {
    await pool.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1", [phone]);
    return false;
  }
  await pool.query("DELETE FROM otp_codes WHERE phone = $1", [phone]);
  return true;
}

/* ---------- applications ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase().slice(0, 8))
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/|application\/pdf$)/.test(file.mimetype))
});

app.post("/api/applications", submitLimit, upload.any(), async (req, res) => {
  const b = req.body, files = req.files || [];
  const cleanup = () => files.forEach(f => fs.rm(f.path, () => {}));
  const fin = String(b.fin || "").toUpperCase();
  const phone = normPhone(b.phone);
  const sources = String(b.incomeSources || "").split(",").filter(s => INCOME.includes(s));
  const err =
    !/^[0-9A-Z]{7}$/.test(fin) ? "FİN kod düzgün deyil." :
    !(b.idSeries in SERIES) || !new RegExp(`^\\d{${SERIES[b.idSeries]}}$`).test(b.idNumber || "") ? "Vəsiqə nömrəsi düzgün deyil." :
    !/^994\d{9}$/.test(phone) ? "Mobil nömrə düzgün deyil." :
    !sources.length ? "Gəlir mənbəyi seçilməyib." :
    sources.includes("biz") && !/^\d{10}$/.test(b.voen || "") ? "VÖEN 10 rəqəm olmalıdır." :
    !b.brand || !b.model ? "Avtomobil seçilməyib." :
    b.consent !== "true" ? "Razılıq verilməyib." : null;
  const fake = files.find(f => !INCOME.includes(f.fieldname.replace(/^file_/, "")) || !sniff(f.path));
  if (!err && fake) { cleanup(); return bad(res, `"${fake.originalname}" PDF və ya şəkil deyil.`); }
  if (err) { cleanup(); return bad(res, err); }
  if (!(await checkOtp(phone, String(b.otp || "")))) { cleanup(); return bad(res, "SMS kodu yanlışdır və ya vaxtı bitib.", 401); }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let id;
    for (let i = 0; i < 5 && !id; i++) {
      const cand = `AA-${new Date().getFullYear()}-${crypto.randomInt(100000, 1000000)}`;
      const r = await client.query(
        `INSERT INTO applications (id, fin, id_series, id_number, phone, income_sources, voen, brand, model, consent_text, consent_at, client_ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [cand, fin, b.idSeries, b.idNumber, phone, sources, sources.includes("biz") ? b.voen : null,
         String(b.brand).slice(0, 60), String(b.model).slice(0, 80), String(b.consentText || "").slice(0, 2000), req.ip]
      );
      id = r.rows[0]?.id;
    }
    await logEvent(client, id, "Müştəri", "created", { files: files.length });
    for (const f of files) {
      const src = f.fieldname.replace(/^file_/, "");
      if (!INCOME.includes(src)) continue;
      await client.query(
        `INSERT INTO application_files (application_id, income_source, original_name, stored_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, src, f.originalname.slice(0, 200), f.filename, sniff(f.path), f.size]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ id, status: "review" });
  } catch (e) {
    await client.query("ROLLBACK"); cleanup(); console.error(e);
    bad(res, "Müraciət saxlanılmadı. Bir az sonra yenidən cəhd et.", 500);
  } finally { client.release(); }
});

// Customer view: needs the id plus the FİN it was filed with.
app.get("/api/applications/:id", lookupLimit, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, created_at, brand, model, status, offer, updated_at FROM applications WHERE id = $1 AND fin = $2",
    [req.params.id, String(req.query.fin || "").toUpperCase()]
  );
  rows[0] ? res.json(rows[0]) : bad(res, "Müraciət tapılmadı.", 404);
});

app.post("/api/applications/:id/cancel", lookupLimit, async (req, res) => {
  const r = await pool.query(
    "UPDATE applications SET status = 'cancelled', updated_at = now() WHERE id = $1 AND fin = $2 AND status IN ('review','offer') RETURNING id",
    [req.params.id, String(req.body.fin || "").toUpperCase()]
  );
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, "Müştəri", "cancelled");
  res.json({ ok: true });
});

app.post("/api/applications/:id/decision", lookupLimit, async (req, res) => {
  const d = req.body.decision;
  if (!["accepted", "declined"].includes(d)) return bad(res, "Qərar düzgün deyil.");
  const r = await pool.query(
    "UPDATE applications SET status = $3, updated_at = now() WHERE id = $1 AND fin = $2 AND status = 'offer' RETURNING id",
    [req.params.id, String(req.body.fin || "").toUpperCase(), d]
  );
  if (!r.rowCount) return bad(res, "Təklif tapılmadı.", 404);
  await logEvent(pool, req.params.id, "Müştəri", d);
  res.json({ ok: true });
});

/* ---------- staff ---------- */
const tokenHash = sha(ADMIN_TOKEN);
const admin = (req, res, next) => adminFail(req, res, () => {
  const t = req.get("x-admin-token") || "";
  if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12 || !crypto.timingSafeEqual(Buffer.from(sha(t)), Buffer.from(tokenHash))) return bad(res, "İcazə yoxdur.", 401);
  adminFail.forgive(req);
  // Staff name comes from the panel; it is recorded on every action.
  let name = ""; try { name = decodeURIComponent(req.get("x-staff-name") || ""); } catch {}
  req.staff = name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Əməkdaş";
  next();
});
const num = (v, lo, hi) => { const x = +v; return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };

app.get("/api/admin/applications", admin, async (req, res) => {
  const q = String(req.query.q || "").trim().toUpperCase();
  const st = String(req.query.status || "");
  const { rows } = await pool.query(
    `SELECT id, created_at, updated_at, fin, phone, brand, model, income_sources, status,
            assessment->'result'->>'grade' AS grade, (assessment->'result'->>'score')::int AS score
     FROM applications
     WHERE ($1 = '' OR status = $1)
       AND ($2 = '' OR id ILIKE '%' || $2 || '%' OR fin ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%' OR upper(model) LIKE '%' || $2 || '%')
     ORDER BY created_at DESC LIMIT 500`, [st, q]);
  const counts = await pool.query("SELECT status, count(*)::int AS n FROM applications GROUP BY status");
  res.json({ items: rows, counts: Object.fromEntries(counts.rows.map(r => [r.status, r.n])) });
});

app.get("/api/admin/stats", admin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
           count(*) FILTER (WHERE status = 'review')::int AS waiting,
           count(*) FILTER (WHERE status = 'review' AND created_at < now() - interval '24 hours')::int AS overdue,
           count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status IN ('offer','accepted','declined'))::int AS approved30,
           count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status IN ('offer','accepted','declined','rejected'))::int AS decided30,
           count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
           round(avg((assessment->'result'->>'score')::int))::int AS avg_score
    FROM applications`);
  res.json(rows[0]);
});

app.get("/api/admin/applications/:id", admin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM applications WHERE id = $1", [req.params.id]);
  if (!rows[0]) return bad(res, "Müraciət tapılmadı.", 404);
  const files = await pool.query("SELECT * FROM application_files WHERE application_id = $1 ORDER BY id", [req.params.id]);
  const events = await pool.query("SELECT * FROM application_events WHERE application_id = $1 ORDER BY at, id", [req.params.id]);
  res.json({ ...rows[0], files: files.rows, events: events.rows });
});

// Saves the analyst's inputs; the score is always recomputed on the server.
app.put("/api/admin/applications/:id/assessment", admin, async (req, res) => {
  const b = req.body || {};
  const inputs = {
    incomeMonthly: num(b.incomeMonthly, 0, 1e6) ?? 0, debtMonthly: num(b.debtMonthly, 0, 1e6) ?? 0,
    activeLoans: num(b.activeLoans, 0, 100) ?? 0, overdueNow: !!b.overdueNow,
    maxOverdue: ["0", "1-30", "31-90", "90+"].includes(b.maxOverdue) ? b.maxOverdue : "0",
    tenureMonths: num(b.tenureMonths, 0, 1000) ?? 0, docsOk: !!b.docsOk,
    price: num(b.price, 0, 1e7) ?? 0, downPct: num(b.downPct, 0, 90) ?? 20,
    months: num(b.months, 6, 84) ?? 36, rate: num(b.rate, 0, 60) ?? 17,
    akbNote: String(b.akbNote || "").slice(0, 1000)
  };
  const result = Scoring.assess(inputs);
  const assessment = { inputs, result, by: req.staff, at: new Date().toISOString() };
  const r = await pool.query("UPDATE applications SET assessment = $2, updated_at = now() WHERE id = $1 RETURNING id", [req.params.id, assessment]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, req.staff, "assessed", { score: result.score, grade: result.grade, verdict: result.verdict });
  res.json(assessment);
});

// Staff send the offer back; the page then shows it with the payment schedule.
app.post("/api/admin/applications/:id/offer", admin, async (req, res) => {
  const b = req.body || {};
  const offer = {
    price: num(b.price, 1000, 1e7), downPct: num(b.downPct ?? 20, 0, 90), months: num(b.months ?? 36, 6, 84),
    rate: num(b.rate ?? 17, 0, 60), commissionPct: num(b.commissionPct ?? 1.5, 0, 10), at: new Date().toISOString()
  };
  if (offer.price == null) return bad(res, "Qiymət düzgün deyil.");
  if (Object.values(offer).some(v => v == null)) return bad(res, "Təklif şərtləri düzgün deyil.");
  const r = await pool.query(
    `UPDATE applications SET status = 'offer', offer = $2, reject_reason = NULL, decided_by = $3, updated_at = now()
     WHERE id = $1 AND status IN ('review','offer','rejected') RETURNING id, phone`, [req.params.id, offer, req.staff]);
  if (!r.rowCount) return bad(res, "Bu müraciətə təklif göndərmək olmur.", 409);
  await logEvent(pool, req.params.id, req.staff, "offer", offer);
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: ${req.params.id} müraciətinizə təklif hazırdır.${SITE_URL ? " Ətraflı: " + SITE_URL : ""}`);
  res.json({ ok: true, offer });
});

app.post("/api/admin/applications/:id/reject", admin, async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!reason) return bad(res, "İmtina səbəbini yaz.");
  const r = await pool.query(
    `UPDATE applications SET status = 'rejected', reject_reason = $2, decided_by = $3, updated_at = now()
     WHERE id = $1 AND status IN ('review','offer') RETURNING id, phone`, [req.params.id, reason, req.staff]);
  if (!r.rowCount) return bad(res, "Bu müraciəti rədd etmək olmur.", 409);
  await logEvent(pool, req.params.id, req.staff, "rejected", { reason });
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: ${req.params.id} müraciətinizə hazırda müsbət cavab verə bilmirik. Sualınız olarsa, bizimlə əlaqə saxlayın.`);
  res.json({ ok: true });
});

app.post("/api/admin/applications/:id/notes", admin, async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  if (!text) return bad(res, "Qeyd boşdur.");
  const r = await pool.query("SELECT 1 FROM applications WHERE id = $1", [req.params.id]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, req.staff, "note", { text });
  res.json({ ok: true });
});

app.get("/api/admin/files/:stored", admin, async (req, res) => {
  const f = path.basename(req.params.stored);
  const { rows } = await pool.query("SELECT original_name, mime FROM application_files WHERE stored_name = $1", [f]);
  if (!rows[0]) return bad(res, "Fayl tapılmadı.", 404);
  res.type(rows[0].mime || "application/octet-stream");
  // A file is shown on its own, never able to run script in the panel's origin.
  res.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(rows[0].original_name)}`);
  res.sendFile(path.join(UPLOAD_DIR, f), err => err && !res.headersSent && bad(res, "Fayl tapılmadı.", 404));
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public/admin.html")));
app.get("/admin/scoring.js", (_req, res) => res.type("js").sendFile(path.join(__dirname, "lib/scoring.js")));

app.use("/api", (_req, res) => bad(res, "Tapılmadı.", 404));
// Errors (bad JSON, oversized or too many files) answer in the page's language without stack traces.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError)
    return bad(res, err.code === "LIMIT_FILE_SIZE" ? "Fayl 10 MB-dan böyük olmamalıdır." : "Fayllar qəbul edilmədi.", 413);
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return bad(res, "Sorğu düzgün deyil.");
  console.error(err);
  bad(res, "Server xətası.", 500);
});

/* ---------- page ---------- */
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "5m" }));

async function start() {
  for (let i = 1; ; i++) {
    try { await pool.query(fs.readFileSync(path.join(__dirname, "db/schema.sql"), "utf8")); break; }
    catch (e) { if (i >= 30) throw e; console.log(`DB gözlənilir (${i})...`); await new Promise(r => setTimeout(r, 2000)); }
  }
  app.listen(PORT, () => console.log(`Arzoom lizinq: http://localhost:${PORT} (SMS provayderi: ${SMS_ON ? "qoşulub" : "yoxdur"}, demo SMS: ${DEMO_SMS})`));
}
start().catch(e => { console.error(e); process.exit(1); });
