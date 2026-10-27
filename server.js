// Arzoom Avto lizinq: static page + JSON API backed by PostgreSQL.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { Pool } = require("pg");

const PORT = +process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// Until an SMS provider is connected the code is returned to the page so the flow can be tested.
const DEMO_SMS = process.env.DEMO_SMS !== "false";
const INCOME = ["work", "biz", "pension", "social"];
const SERIES = { AZE: 8, AA: 7, AB: 7 };

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.set("trust proxy", true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const normPhone = p => String(p || "").replace(/\D/g, "");
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ---------- health ---------- */
app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, demoSms: DEMO_SMS }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

/* ---------- OTP ---------- */
app.post("/api/otp", async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!/^994\d{9}$/.test(phone)) return bad(res, "Mobil nömrə düzgün deyil.");
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '5 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [phone, sha(phone + code)]
  );
  // TODO: send `code` through the SMS provider here.
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

app.post("/api/applications", upload.any(), async (req, res) => {
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
    for (const f of files) {
      const src = f.fieldname.replace(/^file_/, "");
      if (!INCOME.includes(src)) continue;
      await client.query(
        `INSERT INTO application_files (application_id, income_source, original_name, stored_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, src, f.originalname.slice(0, 200), f.filename, f.mimetype, f.size]
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
app.get("/api/applications/:id", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, created_at, brand, model, status, offer FROM applications WHERE id = $1 AND fin = $2",
    [req.params.id, String(req.query.fin || "").toUpperCase()]
  );
  rows[0] ? res.json(rows[0]) : bad(res, "Müraciət tapılmadı.", 404);
});

app.post("/api/applications/:id/cancel", async (req, res) => {
  const r = await pool.query(
    "UPDATE applications SET status = 'cancelled' WHERE id = $1 AND fin = $2 AND status IN ('review','offer') RETURNING id",
    [req.params.id, String(req.body.fin || "").toUpperCase()]
  );
  r.rowCount ? res.json({ ok: true }) : bad(res, "Müraciət tapılmadı.", 404);
});

app.post("/api/applications/:id/decision", async (req, res) => {
  const d = req.body.decision;
  if (!["accepted", "declined"].includes(d)) return bad(res, "Qərar düzgün deyil.");
  const r = await pool.query(
    "UPDATE applications SET status = $3 WHERE id = $1 AND fin = $2 AND status = 'offer' RETURNING id",
    [req.params.id, String(req.body.fin || "").toUpperCase(), d]
  );
  r.rowCount ? res.json({ ok: true }) : bad(res, "Təklif tapılmadı.", 404);
});

/* ---------- staff ---------- */
const admin = (req, res, next) =>
  ADMIN_TOKEN && req.get("x-admin-token") === ADMIN_TOKEN ? next() : bad(res, "İcazə yoxdur.", 401);

app.get("/api/admin/applications", admin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') AS files
     FROM applications a LEFT JOIN application_files f ON f.application_id = a.id
     GROUP BY a.id ORDER BY a.created_at DESC LIMIT 500`
  );
  res.json(rows);
});

// Staff send the offer back; the page then shows it with the payment schedule.
app.post("/api/admin/applications/:id/offer", admin, async (req, res) => {
  const { price, downPct = 20, months = 36, rate = 17, commissionPct = 1.5 } = req.body;
  if (!(price > 0)) return bad(res, "Qiymət düzgün deyil.");
  const offer = { price, downPct, months, rate, commissionPct, at: new Date().toISOString() };
  const r = await pool.query("UPDATE applications SET status = 'offer', offer = $2 WHERE id = $1 RETURNING id", [req.params.id, offer]);
  r.rowCount ? res.json({ ok: true, offer }) : bad(res, "Müraciət tapılmadı.", 404);
});

app.get("/api/admin/files/:stored", admin, (req, res) => {
  const f = path.basename(req.params.stored);
  res.sendFile(path.join(UPLOAD_DIR, f), err => err && bad(res, "Fayl tapılmadı.", 404));
});

/* ---------- page ---------- */
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "5m" }));

async function start() {
  for (let i = 1; ; i++) {
    try { await pool.query(fs.readFileSync(path.join(__dirname, "db/schema.sql"), "utf8")); break; }
    catch (e) { if (i >= 30) throw e; console.log(`DB gözlənilir (${i})...`); await new Promise(r => setTimeout(r, 2000)); }
  }
  app.listen(PORT, () => console.log(`Arzoom lizinq: http://localhost:${PORT} (demo SMS: ${DEMO_SMS})`));
}
start().catch(e => { console.error(e); process.exit(1); });
