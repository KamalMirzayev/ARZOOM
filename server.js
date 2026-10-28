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
const { hashPassword, checkPassword, weakPassword } = require("./lib/passwords");

const PORT = +process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// Until an SMS provider is connected (SMS_URL) the code is returned to the page so the flow can be tested.
const DEMO_SMS = !SMS_ON && process.env.DEMO_SMS !== "false";
// Until SMS works every code is DEMO_OTP (123456 by default); with a provider codes are random.
const newCode = () => DEMO_SMS ? (process.env.DEMO_OTP || "123456") : String(crypto.randomInt(100000, 1000000));
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
async function notify(id, phone, text, to = "Müştəri") {
  // Without a provider the message is only recorded, so staff can see what would have gone out.
  if (!SMS_ON) return logEvent(pool, id, "Sistem", "sms", { to, text, demo: true }).catch(() => {});
  try { await sendSms(phone, text); await logEvent(pool, id, "Sistem", "sms", { to, text }); }
  catch (e) { console.error(e.message); await logEvent(pool, id, "Sistem", "sms", { to, text, error: e.message }).catch(() => {}); }
}
const money = x => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " AZN";
// Final terms the customer confirmed: the offer with their chosen down payment.
function finalTerms(o, dp) {
  const down = o.price * dp / 100, F = o.price - down;
  return { dp, down, months: o.months, pay: Scoring.pmt(F, o.rate, o.months) };
}
// After the customer confirms, the final offer goes by SMS to the customer, underwriting and sales at once.
async function announceAccepted(id) {
  const { rows } = await pool.query("SELECT phone, brand, model, offer FROM applications WHERE id = $1", [id]);
  const a = rows[0]; if (!a?.offer?.final) return;
  const t = finalTerms(a.offer, a.offer.final.downPct);
  const terms = `ilkin ödəniş ${t.dp}% (${money(t.down)}), aylıq ${money(t.pay)}, ${t.months} ay`;
  const panel = SITE_URL ? ` Panel: ${SITE_URL}/admin` : "";
  const staff = await pool.query("SELECT name, role, phone FROM staff_users WHERE active AND phone IS NOT NULL");
  await Promise.all([
    notify(id, a.phone, `Arzoom Avto: Müraciət № ${id}. Son təklifi təsdiqlədiniz: ${a.brand} ${a.model}, ${terms}. Satış mütəxəssisi sizinlə əlaqə saxlayacaq.`),
    ...staff.rows.map(u => notify(id, u.phone, u.role === "sales"
      ? `Arzoom Avto: Müraciət № ${id} satışa ötürüldü. Müştəri son təklifi təsdiqlədi: ${a.brand} ${a.model}, ${terms}. Müştəri ilə əlaqə saxlayın.${panel}`
      : `Arzoom Avto: Müraciət № ${id} anderraytinq üçün. Müştəri son təklifi təsdiqlədi: ${a.brand} ${a.model}, ${terms}.${panel}`, u.name))
  ]);
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
const verifyLimit = rateLimit({ windowMs: 15 * 60e3, max: 20 });
const adminFail = rateLimit({ windowMs: 15 * 60e3, max: 10, message: "Çox sayda uğursuz giriş. 15 dəqiqə sonra yenidən cəhd et." });

app.post("/api/otp", otpLimit, async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!/^994\d{9}$/.test(phone)) return bad(res, "Mobil nömrə düzgün deyil.");
  const prev = await pool.query("SELECT 1 FROM otp_codes WHERE phone = $1 AND expires_at > now() + interval '4 minutes'", [phone]);
  if (prev.rowCount) return bad(res, "Kod artıq göndərilib. Yenisini 1 dəqiqədən sonra istəyə bilərsən.", 429);
  const code = newCode();
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

// After an SMS check the browser gets a random key for that one application; only its hash is stored.
async function issueToken(db, appId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query("INSERT INTO app_tokens (token_hash, application_id, expires_at) VALUES ($1,$2, now() + interval '90 days')", [sha(token), appId]);
  await db.query("DELETE FROM app_tokens WHERE expires_at < now()");
  return token;
}
async function tokenApp(req) {
  const t = String(req.get("x-app-token") || "");
  if (t.length < 20) return null;
  const { rows } = await pool.query(
    "SELECT application_id FROM app_tokens WHERE token_hash = $1 AND application_id = $2 AND expires_at > now()", [sha(t), req.params.id]);
  return rows[0]?.application_id || null;
}
const num = (v, lo, hi) => { const x = +v; return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const maskPhone = p => `+${p.slice(0, 3)} ${p.slice(3, 5)} *** ** ${p.slice(-2)}`;
const CUSTOMER_FIELDS = `a.id, a.created_at, a.updated_at, a.fin, a.id_series, a.id_number, a.phone, a.income_sources, a.voen,
  a.brand, a.model, a.status, a.offer, (SELECT count(*)::int FROM application_files f WHERE f.application_id = a.id) AS files`;

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
    const token = await issueToken(client, id);
    await client.query("COMMIT");
    res.status(201).json({ id, status: "review", token });
    notify(id, phone, `Arzoom Avto: Müraciətiniz qəbul edildi. Müraciət № ${id}. Bu nömrə və FİN kodunuzla müraciətin vəziyyətinə saytda baxa bilərsiniz.${SITE_URL ? " " + SITE_URL : ""}`);
  } catch (e) {
    await client.query("ROLLBACK"); cleanup(); console.error(e);
    bad(res, "Müraciət saxlanılmadı. Bir az sonra yenidən cəhd et.", 500);
  } finally { client.release(); }
});

// Customer finds an application from any device: id + FİN, then an SMS code to the phone on file.
const findApp = async (id, fin) => (await pool.query(
  "SELECT id, phone, status FROM applications WHERE id = $1 AND fin = $2",
  [String(id || "").trim().toUpperCase(), String(fin || "").trim().toUpperCase()])).rows[0];

app.post("/api/lookup/otp", otpLimit, async (req, res) => {
  const a = await findApp(req.body?.id, req.body?.fin);
  if (!a) return bad(res, "Bu nömrə və FİN ilə müraciət tapılmadı.", 404);
  const prev = await pool.query("SELECT 1 FROM otp_codes WHERE phone = $1 AND expires_at > now() + interval '4 minutes'", [a.phone]);
  if (prev.rowCount) return bad(res, "Kod artıq göndərilib. Yenisini 1 dəqiqədən sonra istəyə bilərsən.", 429);
  const code = newCode();
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '5 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [a.phone, sha(a.phone + code)]);
  if (SMS_ON) {
    try { await sendSms(a.phone, `Arzoom Avto: Müraciət № ${a.id}. Giriş kodu ${code}. Kodu heç kimə deməyin.`); }
    catch (e) { console.error(e.message); await pool.query("DELETE FROM otp_codes WHERE phone = $1", [a.phone]); return bad(res, "SMS göndərilmədi. Bir az sonra yenidən cəhd et.", 502); }
  }
  res.json({ sent: true, phone: maskPhone(a.phone), ...(DEMO_SMS ? { demoCode: code } : {}) });
});

app.post("/api/lookup/verify", verifyLimit, async (req, res) => {
  const a = await findApp(req.body?.id, req.body?.fin);
  if (!a || !(await checkOtp(a.phone, String(req.body?.code || "")))) return bad(res, "Kod yanlışdır və ya vaxtı bitib.", 401);
  const token = await issueToken(pool, a.id);
  await logEvent(pool, a.id, "Müştəri", "note", { text: "Müştəri SMS ilə kabinetə daxil oldu" });
  const { rows } = await pool.query(`SELECT ${CUSTOMER_FIELDS} FROM applications a WHERE a.id = $1`, [a.id]);
  res.json({ token, application: rows[0] });
});

// Customer view: needs the key the browser received after the SMS check.
app.get("/api/applications/:id", lookupLimit, async (req, res) => {
  if (!(await tokenApp(req))) return bad(res, "Giriş müddəti bitib. Müraciəti yenidən SMS kodu ilə tap.", 401);
  const { rows } = await pool.query(`SELECT ${CUSTOMER_FIELDS} FROM applications a WHERE a.id = $1`, [req.params.id]);
  rows[0] ? res.json(rows[0]) : bad(res, "Müraciət tapılmadı.", 404);
});

app.post("/api/applications/:id/cancel", lookupLimit, async (req, res) => {
  if (!(await tokenApp(req))) return bad(res, "İcazə yoxdur.", 401);
  const r = await pool.query(
    "UPDATE applications SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('review','offer') RETURNING id",
    [req.params.id]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, "Müştəri", "cancelled");
  res.json({ ok: true });
});

app.post("/api/applications/:id/decision", lookupLimit, async (req, res) => {
  if (!(await tokenApp(req))) return bad(res, "İcazə yoxdur.", 401);
  const d = req.body?.decision;
  if (!["accepted", "declined"].includes(d)) return bad(res, "Qərar düzgün deyil.");
  const { rows } = await pool.query("SELECT offer FROM applications WHERE id = $1 AND status = 'offer'", [req.params.id]);
  if (!rows[0]) return bad(res, "Təklif tapılmadı.", 404);
  // The customer may only raise the down payment, never lower it below what was offered.
  let final = null;
  if (d === "accepted") {
    const dp = num(req.body?.downPct ?? rows[0].offer.downPct, rows[0].offer.downPct, 70);
    if (dp == null) return bad(res, `İlkin ödəniş ${rows[0].offer.downPct}% ilə 70% arasında olmalıdır.`);
    final = { downPct: dp, at: new Date().toISOString() };
  }
  await pool.query(
    `UPDATE applications SET status = $2, updated_at = now(),
       offer = CASE WHEN $3::jsonb IS NULL THEN offer ELSE jsonb_set(offer, '{final}', $3::jsonb) END
     WHERE id = $1 AND status = 'offer'`, [req.params.id, d, final]);
  await logEvent(pool, req.params.id, "Müştəri", d, final);
  if (d === "accepted") announceAccepted(req.params.id).catch(e => console.error(e.message));
  res.json({ ok: true, final });
});

/* ---------- staff ---------- */
// Staff sign in with their own username and password; the panel then sends a 12-hour session key.
const admin = (req, res, next) => adminFail(req, res, async () => {
  const t = String(req.get("x-admin-token") || "");
  const { rows } = t.length < 20 ? { rows: [] } : await pool.query(
    `SELECT u.id, u.username, u.name, u.role FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha(t)]);
  if (!rows[0]) return bad(res, "Sessiya bitib, yenidən daxil ol.", 401);
  adminFail.forgive(req);
  req.user = rows[0];
  req.staff = rows[0].name;
  next();
});
const adminOnly = (req, res, next) => req.user.role === "admin" ? next() : bad(res, "Bu əməliyyat yalnız admin üçündür.", 403);
// Sales staff see applications and write notes; credit decisions stay with experts and admins.
const decider = (req, res, next) => req.user.role !== "sales" ? next() : bad(res, "Satış mütəxəssisi qərar verə bilməz.", 403);
const ROLES = ["admin", "expert", "sales"];
// Optional staff mobile for notifications: empty clears it, otherwise 994XXXXXXXXX.
function staffPhone(v) {
  if (v === undefined) return undefined;
  const p = normPhone(v); if (!p) return "";
  const full = p.length === 9 ? "994" + p : p;
  return /^994\d{9}$/.test(full) ? full : null;
}

app.post("/api/admin/login", adminFail, async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const { rows } = await pool.query("SELECT id, name, role, password_hash, active FROM staff_users WHERE username = $1", [username]);
  const u = rows[0];
  // Same answer for an unknown user and a wrong password.
  if (!u || !u.active || !checkPassword(req.body?.password, u.password_hash)) return bad(res, "İstifadəçi adı və ya parol yanlışdır.", 401);
  adminFail.forgive(req);
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO staff_sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '12 hours')", [sha(token), u.id]);
  await pool.query("UPDATE staff_users SET last_login = now() WHERE id = $1", [u.id]);
  await pool.query("DELETE FROM staff_sessions WHERE expires_at < now()");
  res.json({ token, user: { username, name: u.name, role: u.role } });
});

app.post("/api/admin/logout", admin, async (req, res) => {
  await pool.query("DELETE FROM staff_sessions WHERE token_hash = $1", [sha(req.get("x-admin-token"))]);
  res.json({ ok: true });
});

app.get("/api/admin/me", admin, (req, res) => res.json(req.user));

app.post("/api/admin/me/password", admin, async (req, res) => {
  const { rows } = await pool.query("SELECT password_hash FROM staff_users WHERE id = $1", [req.user.id]);
  if (!checkPassword(req.body?.current, rows[0].password_hash)) return bad(res, "Hazırkı parol yanlışdır.");
  const w = weakPassword(req.body?.next); if (w) return bad(res, w);
  await pool.query("UPDATE staff_users SET password_hash = $2 WHERE id = $1", [req.user.id, hashPassword(req.body.next)]);
  // Other devices are signed out; this one keeps its session.
  await pool.query("DELETE FROM staff_sessions WHERE user_id = $1 AND token_hash <> $2", [req.user.id, sha(req.get("x-admin-token"))]);
  res.json({ ok: true });
});

app.get("/api/admin/users", admin, adminOnly, async (_req, res) => {
  const { rows } = await pool.query("SELECT id, username, name, role, phone, active, created_at, last_login FROM staff_users ORDER BY created_at");
  res.json(rows);
});

app.post("/api/admin/users", admin, adminOnly, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || "").trim().toLowerCase();
  const name = String(b.name || "").trim().slice(0, 60);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return bad(res, "İstifadəçi adı 3–32 simvol: kiçik latın hərfləri, rəqəm, nöqtə, tire.");
  if (!name) return bad(res, "Ad və soyadı yaz.");
  const w = weakPassword(b.password); if (w) return bad(res, w);
  const role = ROLES.includes(b.role) ? b.role : "expert";
  const phone = staffPhone(b.phone ?? "");
  if (phone === null) return bad(res, "Mobil nömrə düzgün deyil. Məs. 50 123 45 67");
  const r = await pool.query(
    "INSERT INTO staff_users (username, name, password_hash, role, phone) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING RETURNING id",
    [username, name, hashPassword(b.password), role, phone || null]);
  r.rowCount ? res.status(201).json({ id: r.rows[0].id }) : bad(res, "Bu istifadəçi adı artıq var.", 409);
});

app.post("/api/admin/users/:id", admin, adminOnly, async (req, res) => {
  const b = req.body || {}, id = +req.params.id;
  if (id === +req.user.id && (b.active === false || (b.role && b.role !== "admin"))) return bad(res, "Öz admin hesabını söndürə və ya rolunu dəyişə bilməzsən.");
  const phone = staffPhone(b.phone);
  if (phone === null) return bad(res, "Mobil nömrə düzgün deyil. Məs. 50 123 45 67");
  if (b.password != null) { const w = weakPassword(b.password); if (w) return bad(res, w); }
  const r = await pool.query(
    `UPDATE staff_users SET
       active = COALESCE($2, active), role = COALESCE($3, role), password_hash = COALESCE($4, password_hash),
       phone = CASE WHEN $5::text IS NULL THEN phone ELSE NULLIF($5, '') END
     WHERE id = $1 RETURNING id`,
    [id, typeof b.active === "boolean" ? b.active : null, ROLES.includes(b.role) ? b.role : null,
     b.password != null ? hashPassword(b.password) : null, phone ?? null]);
  if (!r.rowCount) return bad(res, "İstifadəçi tapılmadı.", 404);
  if (b.active === false || b.password != null) await pool.query("DELETE FROM staff_sessions WHERE user_id = $1", [id]);
  res.json({ ok: true });
});

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
app.put("/api/admin/applications/:id/assessment", admin, decider, async (req, res) => {
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
app.post("/api/admin/applications/:id/offer", admin, decider, async (req, res) => {
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
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id}. Təklifiniz hazırdır, ödəniş qrafikinə baxıb təsdiqləyin.${SITE_URL ? " Ətraflı: " + SITE_URL : ""}`);
  res.json({ ok: true, offer });
});

app.post("/api/admin/applications/:id/reject", admin, decider, async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!reason) return bad(res, "İmtina səbəbini yaz.");
  const r = await pool.query(
    `UPDATE applications SET status = 'rejected', reject_reason = $2, decided_by = $3, updated_at = now()
     WHERE id = $1 AND status IN ('review','offer') RETURNING id, phone`, [req.params.id, reason, req.staff]);
  if (!r.rowCount) return bad(res, "Bu müraciəti rədd etmək olmur.", 409);
  await logEvent(pool, req.params.id, req.staff, "rejected", { reason });
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id}. Hazırda müraciətinizə müsbət cavab verə bilmirik. Sualınız olarsa, bizimlə əlaqə saxlayın.`);
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

// Only admins delete. Files on disk go too; the deletion itself stays in deletion_log.
app.delete("/api/admin/applications/:id", admin, adminOnly, async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  if (reason.length < 3) return bad(res, "Silmə səbəbini yaz.");
  const client = await pool.connect();
  let files = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT id, fin, brand, model, status, created_at FROM applications WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows[0]) { await client.query("ROLLBACK"); return bad(res, "Müraciət tapılmadı.", 404); }
    files = (await client.query("SELECT stored_name FROM application_files WHERE application_id = $1", [req.params.id])).rows;
    await client.query("INSERT INTO deletion_log (application_id, deleted_by, reason, summary) VALUES ($1,$2,$3,$4)",
      [req.params.id, `${req.staff} (${req.user.username})`, reason, rows[0]]);
    await client.query("DELETE FROM applications WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
  for (const f of files) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(f.stored_name))).catch(() => {});
  console.log(`Müraciət silindi: ${req.params.id}, ${req.user.username}`);
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
  // First start: the "admin" account gets ADMIN_TOKEN from .env as its password; change it after signing in.
  const users = await pool.query("SELECT count(*)::int AS n FROM staff_users");
  if (!users.rows[0].n && ADMIN_TOKEN) {
    await pool.query("INSERT INTO staff_users (username, name, password_hash, role) VALUES ('admin', 'Administrator', $1, 'admin')", [hashPassword(ADMIN_TOKEN)]);
    console.log("İlk admin hesabı yaradıldı: istifadəçi adı admin, parol .env-dəki ADMIN_TOKEN.");
  }
  app.listen(PORT, () => console.log(`Arzoom lizinq: http://localhost:${PORT} (SMS provayderi: ${SMS_ON ? "qoşulub" : "yoxdur"}, demo SMS: ${DEMO_SMS})`));
}
start().catch(e => { console.error(e); process.exit(1); });
