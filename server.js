// Arzoom Avto lizinq: static page + JSON API backed by PostgreSQL.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { Pool, types } = require("pg");
// DATE columns stay plain YYYY-MM-DD strings, with no time zone shift.
types.setTypeParser(1082, v => v);
const Sms = require("./lib/sms");
const { CALL_RESULTS, ROBO_RESULTS, EXPORT_STATUS } = require("./lib/labels");
const History = require("./lib/history");
const Xlsx = require("./lib/xlsx");
const Stock = require("./lib/stock");
const { sendSms } = Sms;
const Scoring = require("./lib/scoring");
const Akb = require("./lib/akb");
const Ocr = require("./lib/ocr");
const Perms = require("./lib/permissions");
const { rateLimit } = require("./lib/ratelimit");
const { sniff } = require("./lib/filecheck");
const { hashPassword, checkPassword, weakPassword } = require("./lib/passwords");

const PORT = +process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// Codes are always random and only ever leave the server by SMS: there is no test or demo code.
const newCode = () => String(crypto.randomInt(100000, 1000000));
const NO_SMS = "SMS xidməti hazırda əlçatan deyil. Bir az sonra yenidən cəhd et və ya *5665 nömrəsinə zəng et.";
const SITE_URL = process.env.SITE_ADDRESS && process.env.SITE_ADDRESS !== "localhost" ? `https://${process.env.SITE_ADDRESS}` : "";
// Partner link (e.g. Bitrix): ?partner=groupmotors&ref=111938. Only short codes are kept; anything else is dropped.
const partnerCode = v => (/^[A-Za-z0-9_.-]{1,64}$/.test(String(v || "").trim()) ? String(v).trim() : null);
const INCOME = ["work", "informal", "biz", "pension", "social"];
const INCOME_NAMES = { work: "rəsmi iş", informal: "qeyri-rəsmi gəlirlər", biz: "sahibkar", pension: "pensiya", social: "sosial yardım" };
// Sources that cannot be accepted without a document: informal income needs a debit-card statement, contract, lease or similar proof.
// Every income source the customer picks needs at least one document.
const DOC_REQUIRED = {
  work: "Rəsmi iş yeri üçün sənəd məcburidir: əmək haqqı arayışı və ya bank çıxarışı.",
  informal: "Qeyri-rəsmi gəlirlər üçün sənəd məcburidir: debet kart çıxarışı, müqavilə, icarə müqaviləsi və ya digər.",
  biz: "Sahibkar üçün sənəd məcburidir: VÖEN çıxarışı və ya son 6 ayın bank çıxarışı.",
  pension: "Pensiya üçün sənəd məcburidir: pensiya vəsiqəsi və ya ödəniş arayışı.",
  social: "Sosial yardım üçün sənəd məcburidir: təyinat haqqında arayış."
};
// Date of birth as YYYY-MM-DD: a real calendar date, 18 to 80 years ago.
function birthDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "")); if (!m) return null;
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  const now = new Date(), age = (y, dd) => Date.UTC(now.getUTCFullYear() - y, now.getUTCMonth(), now.getUTCDate()) - dd.getTime();
  return age(18, d) >= 0 && age(80, d) < 0 ? m[0] : null;
}
const SERIES = { AZE: 8, AA: 7, AB: 7 };
// Car names come from the page's catalogue; anything with markup or quotes is refused (they reach the panel and staff SMS).
const CAR_TEXT = /^[\p{L}\p{N} .,:+&()\/-]{1,80}$/u;
// OTP hashes are keyed with a secret so a database copy alone does not reveal the 6-digit codes.
const OTP_KEY = process.env.OTP_SECRET || crypto.randomBytes(32).toString("hex");
const STAFF_IDLE = process.env.STAFF_IDLE_MINUTES || "120";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// A dropped idle connection must not take the whole server down.
pool.on("error", e => console.error("DB:", e.message));
const app = express();
// Only the Caddy proxy on the private Docker network is trusted for X-Forwarded-For.
app.set("trust proxy", "loopback, uniquelocal");
app.disable("x-powered-by");
// Only the pages' own inline scripts may run, by hash: injected markup cannot execute script.
const scriptHashes = fs.readdirSync(path.join(__dirname, "public")).filter(f => f.endsWith(".html")).flatMap(f =>
  [...fs.readFileSync(path.join(__dirname, "public", f), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...scriptHashes],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"], // call recordings play from a blob fetched through the panel
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
// ArzoomCall's analytics snapshot carries up to 100 recent calls with summaries, so that one path takes a larger body.
const jsonSmall = express.json({ limit: "100kb" }), jsonLarge = express.json({ limit: "3mb" });
app.use((req, res, next) => (req.path === "/api/integrations/robocall/analytics" ? jsonLarge : jsonSmall)(req, res, next));

// Browsers send multipart file names as UTF-8, multer reads them as Latin-1 ("Ã§Ä±xarÄ±Å"): decode them back.
// Names with characters above U+00FF are already right; Latin-1 bytes that are not valid UTF-8 stay as they are.
function fixName(n) {
  n = String(n || "");
  if (!/[\u0080-\u00ff]/.test(n) || /[^\u0000-\u00ff]/.test(n)) return n;
  const u = Buffer.from(n, "latin1").toString("utf8");
  return u.includes("\ufffd") ? n : u;
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const otpHash = (phone, code) => crypto.createHmac("sha256", OTP_KEY).update(`${phone}:${code}`).digest("hex");
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normPhone = p => String(p || "").replace(/\D/g, "");
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const logEvent = (db, id, actor, kind, details = null) =>
  db.query("INSERT INTO application_events (application_id, actor, kind, details) VALUES ($1,$2,$3,$4)", [id, actor, kind, details])
    .then(r => { if (kind !== "webhook") queueHistory(id); return r; });
// Security log of staff actions: sign-ins, account changes, document views, deletions.
const audit = (req, username, action, target = null) =>
  pool.query("INSERT INTO audit_log (username, ip, action, target) VALUES ($1,$2,$3,$4)", [username, req.ip, action, target == null ? null : String(target)])
    .catch(e => console.error(e.message));
// Customer notifications must never break the staff action that triggered them.
async function notify(id, phone, text, to = "Müştəri") {
  // Without a provider the message is only recorded, so staff can see what would have gone out.
  if (!Sms.configured()) return logEvent(pool, id, "Sistem", "sms", { to, text, error: "SMS provayderi qoşulmayıb" }).catch(() => {});
  try { await sendSms(phone, text); await logEvent(pool, id, "Sistem", "sms", { to, text }); }
  catch (e) { console.error(e.message); await logEvent(pool, id, "Sistem", "sms", { to, text, error: e.message }).catch(() => {}); }
}
const money = x => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " AZN";
const cabinet = () => SITE_URL ? ` ${SITE_URL}/#muracietlerim` : "";
// Customer-facing rejection reasons; staff pick one, it goes to the cabinet and the SMS.
const REJECT_REASONS = {
  credit: "Kredit tarixçəniz lizinq şərtlərimizə uyğun gəlmir.",
  income: "Təsdiqlənmiş gəliriniz seçdiyiniz avtomobilin aylıq ödənişi üçün kifayət etmir.",
  debt: "Mövcud kredit öhdəlikləriniz səbəbindən borc yükünüz icazə verilən həddən yüksəkdir.",
  docs: "Təqdim etdiyiniz sənədlər natamamdır və ya yoxlanıla bilmədi.",
  terms: "Müraciətiniz lizinq şərtlərimizə uyğun gəlmir."
};
// Bank commission follows the down payment: up to 20% → 3%, up to 30% → 2%, above 30% → 1%.
const commissionFor = dp => dp <= 20 ? 3 : dp <= 30 ? 2 : 1;
// Two separate commissions. The bank's is on the down payment (3/2/1% by down payment unless staff typed their own) and the
// customer sees it under "Digər xərclər". The organization's own is on the credit amount (1.5% by default) and stays with
// staff. Offers sent before the split kept the bank commission in commissionPct/commissionAuto.
const ORG_COMMISSION = 1.5;
const split = o => o.bankCommissionPct !== undefined;
const bankPct = (o, dp) => split(o) ? (o.bankCommissionAuto ? commissionFor(dp) : +o.bankCommissionPct || 0)
  : o.commissionAuto === false ? +o.commissionPct || 0 : commissionFor(dp);
const orgPct = o => split(o) || o.commissionAuto === undefined ? +o.commissionPct || 0 : ORG_COMMISSION;
// The customer's copy of the offer: the bank commission only, never the organization's.
function customerOffer(o) {
  if (!o) return o;
  const { commissionPct, commissionAuto, ...rest } = o;
  return { ...rest, bankCommissionAuto: split(o) ? !!o.bankCommissionAuto : o.commissionAuto !== false, bankCommissionPct: bankPct(o, o.downPct) };
}
const toCustomer = row => row && { ...row, offer: customerOffer(row.offer) };
// Final terms the customer confirmed: the offer with their chosen down payment.
function finalTerms(o, dp) {
  const down = o.price * dp / 100, F = o.price - down;
  // "Digər xərclər": DYP, KASKO, GPS as the expert entered them (AZN) and the bank commission on the down payment.
  const c = o.costs || {}, fee = down * bankPct(o, dp) / 100;
  const other = { dyp: +c.dyp || 0, kasko: +c.kasko || 0, gps: +c.gps || 0, bank_commission: fee };
  other.total = other.dyp + other.kasko + other.gps + other.bank_commission;
  const org = { pct: orgPct(o), amount: F * orgPct(o) / 100 };
  return { dp, down, credit: F, months: o.months, pay: Scoring.pmt(F, o.rate, o.months), fee, other, org };
}
// After the customer confirms, the final offer goes by SMS to the customer, underwriting and sales at once.
async function announceAccepted(id, { customer = true } = {}) {
  const { rows } = await pool.query("SELECT phone, brand, model, offer FROM applications WHERE id = $1", [id]);
  const a = rows[0]; if (!a?.offer?.final) return;
  const t = finalTerms(a.offer, a.offer.final.downPct);
  const terms = `ilkin ödəniş ${t.dp}% (${money(t.down)}), ilkin kredit məbləği ${money(t.credit)}, aylıq ${money(t.pay)}, ${t.months} ay${t.org.amount ? `, təşkilatın komissiyası ${money(t.org.amount)}` : ""}`;
  // Installment sale: the customer's text has no credit amount, interest or commission, only what they pay.
  const own = `ilkin ödəniş ${t.dp}% (${money(t.down)}), aylıq ${money(t.pay)}, ${t.months} ay${t.other.total ? `, digər xərclər ${money(t.other.total)}` : ""}`;
  const panel = SITE_URL ? ` Panel: ${SITE_URL}/admin` : "";
  const staff = await pool.query("SELECT name, role, phone FROM staff_users WHERE active AND phone IS NOT NULL AND (role = 'admin' OR cardinality(brands) = 0 OR $1 = ANY(brands))", [a.brand]);
  await Promise.all([
    customer && notify(id, a.phone, `Arzoom Avto: Müraciət № ${id}. Son təklifi təsdiqlədiniz: ${a.brand} ${a.model}, ${own}. Müqavilə və avtomobilin təhvili üçün satış mütəxəssisi sizinlə əlaqə saxlayacaq.`),
    ...staff.rows.map(u => notify(id, u.phone, u.role === "sales"
      ? `Arzoom Avto: Müraciət № ${id} satışa ötürüldü. Müştəri son təklifi təsdiqlədi: ${a.brand} ${a.model}, ${terms}. Müştəri ilə əlaqə saxlayın.${panel}`
      : `Arzoom Avto: Müraciət № ${id} anderraytinq üçün. Müştəri son təklifi təsdiqlədi: ${a.brand} ${a.model}, ${terms}.${panel}`, u.name))
  ]);
}
// A new application goes by SMS to every active admin, risk expert and sales manager with a phone on file.
// The text carries no FİN or customer phone: staff open the panel for the details.
async function announceNew(id) {
  const { rows } = await pool.query("SELECT brand, model, income_sources FROM applications WHERE id = $1", [id]);
  const a = rows[0]; if (!a) return;
  const panel = SITE_URL ? ` Panel: ${SITE_URL}/admin` : "";
  const staff = await pool.query(
    "SELECT name, phone FROM staff_users WHERE active AND phone IS NOT NULL AND role IN ('admin','expert','sales') AND (role = 'admin' OR cardinality(brands) = 0 OR $1 = ANY(brands))", [a.brand]);
  const text = `Arzoom Avto: Yeni müraciət № ${id}. ${a.brand} ${a.model}, gəlir: ${a.income_sources.map(s => INCOME_NAMES[s] || s).join(", ")}.${panel}`;
  await Promise.all(staff.rows.map(u => notify(id, u.phone, text, u.name)));
}

/* ---------- health ---------- */
app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, sms: Sms.configured() }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

/* ---------- OTP ---------- */
const otpLimit = rateLimit({ windowMs: 15 * 60e3, max: 6 });
const submitLimit = rateLimit({ windowMs: 60 * 60e3, max: 10 });
const lookupLimit = rateLimit({ windowMs: 60e3, max: 60 });
const verifyLimit = rateLimit({ windowMs: 15 * 60e3, max: 20 });
const adminFail = rateLimit({ windowMs: 15 * 60e3, max: 30, message: "Çox sayda uğursuz giriş. 15 dəqiqə sonra yenidən cəhd et." });
// Expired or forged session tokens are counted apart from logins, so stale tabs in a shared office cannot lock everyone out of signing in.
const sessionFail = rateLimit({ windowMs: 15 * 60e3, max: 100, message: "Çox sayda uğursuz sorğu. Bir az sonra yenidən cəhd et." });
// The same limits keyed by the target, so guessing spread over many IPs is stopped too.
// SMS cost guard: a ceiling on codes sent per hour by the whole server, so numbers rotated over many IPs cannot run up the SMS bill.
// Counted only when a code is really about to be sent, so invalid requests cannot use up the ceiling.
const OTP_HOURLY = Number(process.env.OTP_HOURLY_MAX) || 300, otpSent = [];
const otpBudget = () => { const now = Date.now(); while (otpSent.length && otpSent[0] < now - 3600e3) otpSent.shift();
  if (otpSent.length >= OTP_HOURLY) return false; otpSent.push(now); return true; };
const OTP_BUSY = "SMS xidməti hazırda çox yüklənib. Bir az sonra yenidən cəhd et və ya *5665 nömrəsinə zəng et.";
const phoneOtpLimit = rateLimit({ windowMs: 60 * 60e3, max: 5, key: req => "p" + normPhone(req.body?.phone),
  message: "Bu nömrəyə çox sayda kod göndərilib. 1 saat sonra yenidən cəhd et." });
const finLimit = rateLimit({ windowMs: 60 * 60e3, max: 10, key: req => "f" + String(req.body?.fin || "").trim().toUpperCase(),
  message: "Bu FİN üzrə çox sayda cəhd olub. 1 saat sonra yenidən cəhd et." });
const userFail = rateLimit({ windowMs: 15 * 60e3, max: 8, key: req => "u" + String(req.body?.username || "").trim().toLowerCase(),
  message: "Bu hesaba çox sayda uğursuz giriş olub. 15 dəqiqə sonra yenidən cəhd et." });
// Unknown usernames are checked against this hash so they take as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

app.post("/api/otp", otpLimit, phoneOtpLimit, async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!/^994\d{9}$/.test(phone)) return bad(res, "Mobil nömrə düzgün deyil.");
  if (!Sms.configured()) return bad(res, NO_SMS, 503);
  const prev = await pool.query("SELECT 1 FROM otp_codes WHERE phone = $1 AND expires_at > now() + interval '4 minutes'", [phone]);
  if (prev.rowCount) return bad(res, "Kod artıq göndərilib. Yenisini 1 dəqiqədən sonra istəyə bilərsən.", 429);
  if (!otpBudget()) return bad(res, OTP_BUSY, 429);
  const code = newCode();
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '5 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [phone, otpHash(phone, code)]
  );
  try { await sendSms(phone, `Arzoom Avto: təsdiq kodunuz ${code}. Kod 5 dəqiqə etibarlıdır.`, { wait: false }); }
  catch (e) { console.error(e.message); await pool.query("DELETE FROM otp_codes WHERE phone = $1", [phone]); return bad(res, "SMS göndərilmədi. Bir az sonra yenidən cəhd et.", 502); }
  res.json({ sent: true });
});

async function checkOtp(phone, code) {
  // The attempt is counted before the code is compared, in one statement, so parallel guesses cannot
  // all slip in under the 5-attempt limit.
  const { rows } = await pool.query(
    "UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1 AND expires_at > now() AND attempts < 5 RETURNING code_hash", [phone]);
  if (!rows[0] || !sameHex(rows[0].code_hash, otpHash(phone, String(code)))) return false;
  const del = await pool.query("DELETE FROM otp_codes WHERE phone = $1 AND code_hash = $2", [phone, rows[0].code_hash]);
  return del.rowCount === 1;
}

// After an SMS check the browser gets a random key for that one application; only its hash is stored.
async function issueToken(db, appId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query("INSERT INTO app_tokens (token_hash, application_id, expires_at) VALUES ($1,$2, now() + interval '30 days')", [sha(token), appId]);
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
  a.brand, a.model, a.status, a.offer, a.reject_public, a.info_request, (SELECT count(*)::int FROM application_files f WHERE f.application_id = a.id) AS files`;

/* ---------- applications ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // The stored name never takes anything from the uploader; the type is checked from the bytes afterwards.
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 20, fields: 40, fieldSize: 10 * 1024, parts: 60 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/|application\/pdf$)/.test(file.mimetype))
});

app.post("/api/applications", submitLimit, upload.any(), async (req, res) => {
  const b = req.body || {}, files = req.files || [];
  const cleanup = () => files.forEach(f => fs.rm(f.path, () => {}));
  const fin = String(b.fin || "").toUpperCase();
  const phone = normPhone(b.phone);
  const sources = String(b.incomeSources || "").split(",").filter(s => INCOME.includes(s));
  const noDoc = sources.find(s => DOC_REQUIRED[s] && !files.some(f => f.fieldname === "file_" + s));
  const err =
    !/^[0-9A-Z]{7}$/.test(fin) ? "FİN kod düzgün deyil." :
    !Object.hasOwn(SERIES, String(b.idSeries)) || !new RegExp(`^\\d{${SERIES[b.idSeries]}}$`).test(b.idNumber || "") ? "Vəsiqə nömrəsi düzgün deyil." :
    !birthDate(b.birthDate) ? "Doğum tarixi düzgün deyil: müraciət üçün 18 yaş tamam olmalıdır." :
    !/^994\d{9}$/.test(phone) ? "Mobil nömrə düzgün deyil." :
    !sources.length ? "Gəlir mənbəyi seçilməyib." :
    sources.includes("biz") && !/^\d{10}$/.test(b.voen || "") ? "VÖEN 10 rəqəm olmalıdır." :
    noDoc ? DOC_REQUIRED[noDoc] :
    !CAR_TEXT.test(String(b.brand || "")) || !CAR_TEXT.test(String(b.model || "")) ? "Avtomobil seçilməyib." :
    b.consent !== "true" ? "Razılıq verilməyib." :
    !["yes", "no"].includes(b.guarantor) ? "Zamin sualına cavab verilməyib." : null;
  const fake = files.find(f => !INCOME.includes(f.fieldname.replace(/^file_/, "")) || !sniff(f.path));
  if (!err && fake) { cleanup(); return bad(res, `"${String(fake.originalname).slice(0, 100)}" PDF və ya şəkil deyil.`); }
  if (err) { cleanup(); return bad(res, err); }
  if (!(await checkOtp(phone, String(b.otp || "")))) { cleanup(); return bad(res, "SMS kodu yanlışdır və ya vaxtı bitib.", 401); }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let id;
    // The number is built from the customer's own data so they can remember it and nobody else can guess it:
    // last 4 characters of FİN + day and month of birth, e.g. C12D-1705. A repeat application gets -2, -3...
    const dob = birthDate(b.birthDate);
    const base = `${fin.slice(-4)}-${dob.slice(8, 10)}${dob.slice(5, 7)}`;
    for (let i = 0; i < 50 && !id; i++) {
      const cand = i ? `${base}-${i + 1}` : base;
      const r = await client.query(
        `INSERT INTO applications (id, fin, id_series, id_number, phone, income_sources, voen, brand, model, consent_text, consent_at, client_ip, birth_date, guarantor, partner, partner_ref, car_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11, $12, $13, $14, $15, $16) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [cand, fin, b.idSeries, b.idNumber, phone, sources, sources.includes("biz") ? b.voen : null,
         String(b.brand).slice(0, 60), String(b.model).slice(0, 80), String(b.consentText || "").slice(0, 2000), req.ip, birthDate(b.birthDate), b.guarantor === "yes",
         partnerCode(b.partner), partnerCode(b.partnerRef), Stock.priceOf(STOCK.brands, String(b.brand), String(b.model))]
      );
      id = r.rows[0]?.id;
    }
    await logEvent(client, id, "Müştəri", "created", { files: files.length });
    for (const f of files) {
      const src = f.fieldname.replace(/^file_/, "");
      if (!INCOME.includes(src)) continue;
      await client.query(
        `INSERT INTO application_files (application_id, income_source, original_name, stored_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, src, fixName(f.originalname).slice(0, 200), f.filename, sniff(f.path), f.size]
      );
    }
    const token = await issueToken(client, id);
    await client.query("COMMIT");
    res.status(201).json({ id, status: "review", token });
    announceNew(id).catch(e => console.error(e.message));
    sendResult(id);
    notify(id, phone, `Arzoom Avto: Müraciətiniz № ${id} qəbul edildi və yoxlanılır. Qərar barədə SMS göndərəcəyik. Statusa baxmaq:${cabinet() || " saytda, müraciət nömrəsi və FİN kodu ilə."}`);
  } catch (e) {
    await client.query("ROLLBACK"); cleanup(); console.error(e);
    bad(res, "Müraciət saxlanılmadı. Bir az sonra yenidən cəhd et.", 500);
  } finally { client.release(); }
});

// Customer finds an application from any device: id + FİN, then an SMS code to the phone on file.
const findApp = async (id, fin) => (await pool.query(
  "SELECT id, phone, status FROM applications WHERE id = $1 AND fin = $2",
  [String(id || "").trim().toUpperCase(), String(fin || "").trim().toUpperCase()])).rows[0];

app.post("/api/lookup/otp", otpLimit, finLimit, async (req, res) => {
  const a = await findApp(req.body?.id, req.body?.fin);
  if (!a) return bad(res, "Bu nömrə və FİN ilə müraciət tapılmadı.", 404);
  if (!Sms.configured()) return bad(res, NO_SMS, 503);
  const prev = await pool.query("SELECT 1 FROM otp_codes WHERE phone = $1 AND expires_at > now() + interval '4 minutes'", [a.phone]);
  if (prev.rowCount) return bad(res, "Kod artıq göndərilib. Yenisini 1 dəqiqədən sonra istəyə bilərsən.", 429);
  if (!otpBudget()) return bad(res, OTP_BUSY, 429);
  const code = newCode();
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES ($1,$2, now() + interval '5 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [a.phone, otpHash(a.phone, code)]);
  try { await sendSms(a.phone, `Arzoom Avto: Müraciət № ${a.id}. Giriş kodu ${code}. Kodu heç kimə deməyin.`, { wait: false }); }
  catch (e) { console.error(e.message); await pool.query("DELETE FROM otp_codes WHERE phone = $1", [a.phone]); return bad(res, "SMS göndərilmədi. Bir az sonra yenidən cəhd et.", 502); }
  res.json({ sent: true, phone: maskPhone(a.phone) });
});

app.post("/api/lookup/verify", verifyLimit, finLimit, async (req, res) => {
  const a = await findApp(req.body?.id, req.body?.fin);
  if (!a || !(await checkOtp(a.phone, String(req.body?.code || "")))) return bad(res, "Kod yanlışdır və ya vaxtı bitib.", 401);
  const token = await issueToken(pool, a.id);
  await logEvent(pool, a.id, "Müştəri", "note", { text: "Müştəri SMS ilə kabinetə daxil oldu" });
  const { rows } = await pool.query(`SELECT ${CUSTOMER_FIELDS} FROM applications a WHERE a.id = $1`, [a.id]);
  res.json({ token, application: toCustomer(rows[0]) });
});

// Customer view: needs the key the browser received after the SMS check.
app.get("/api/applications/:id", lookupLimit, async (req, res) => {
  if (!(await tokenApp(req))) return bad(res, "Giriş müddəti bitib. Müraciəti yenidən SMS kodu ilə tap.", 401);
  const { rows } = await pool.query(`SELECT ${CUSTOMER_FIELDS} FROM applications a WHERE a.id = $1`, [req.params.id]);
  rows[0] ? res.json(toCustomer(rows[0])) : bad(res, "Müraciət tapılmadı.", 404);
});

// The customer answers a request for more information: a text and/or extra documents. The application goes back to review.
// Each requested document comes in its own field (file_d0, file_d1, ...); free extra files come as file_extra.
app.post("/api/applications/:id/info", lookupLimit, upload.any(), async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach(f => fs.rm(f.path, () => {}));
  if (!(await tokenApp(req))) { cleanup(); return bad(res, "Giriş müddəti bitib. Müraciəti yenidən SMS kodu ilə tap.", 401); }
  if (files.length > 20 || files.some(f => !/^file_(extra|d[0-7])$/.test(f.fieldname))) { cleanup(); return bad(res, "Sənədlər düzgün göndərilməyib."); }
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  const asked = (await pool.query("SELECT info_request FROM applications WHERE id = $1", [req.params.id])).rows[0]?.info_request?.docs || [];
  const missing = asked.find((_, i) => !files.some(f => f.fieldname === "file_d" + i));
  if (missing) { cleanup(); return bad(res, `Bu sənədi yükləyin: ${missing.label}.`); }
  if (!text && !files.length) { cleanup(); return bad(res, "Cavab yazın və ya sənəd əlavə edin."); }
  const fake = files.find(f => !sniff(f.path));
  if (fake) { cleanup(); return bad(res, `"${String(fake.originalname).slice(0, 100)}" PDF və ya şəkil deyil.`); }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE applications SET status = 'review', updated_at = now(),
         info_request = info_request || jsonb_build_object('answer', $2::text, 'answeredAt', now(), 'files', $3::int)
       WHERE id = $1 AND status = 'info' RETURNING id, brand, model, info_request`, [req.params.id, text, files.length]);
    if (!r.rowCount) { await client.query("ROLLBACK"); cleanup(); return bad(res, "Bu müraciət üçün əlavə məlumat gözlənilmir.", 409); }
    for (const f of files) {
      const label = f.fieldname === "file_extra" ? null : asked[+f.fieldname.slice(6)]?.label || null;
      await client.query(
        `INSERT INTO application_files (application_id, income_source, original_name, stored_name, mime, size_bytes, doc_label) VALUES ($1,'extra',$2,$3,$4,$5,$6)`,
        [req.params.id, fixName(f.originalname).slice(0, 200), f.filename, sniff(f.path), f.size, label]);
    }
    await logEvent(client, req.params.id, "Müştəri", "info_reply", { text, files: files.length });
    await client.query("COMMIT");
    res.json({ ok: true, status: "review" });
    // The staff member who asked gets an SMS that the answer is in.
    const by = r.rows[0].info_request?.byUser;
    if (by) {
      const u = (await pool.query("SELECT name, phone FROM staff_users WHERE username = $1 AND active AND phone IS NOT NULL", [by])).rows[0];
      if (u) notify(req.params.id, u.phone, `Arzoom Avto: Müraciət № ${req.params.id} (${r.rows[0].brand} ${r.rows[0].model}) üzrə müştəri əlavə məlumatı göndərdi.${SITE_URL ? ` Panel: ${SITE_URL}/admin` : ""}`, u.name);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {}); cleanup(); console.error(e);
    bad(res, "Cavab saxlanılmadı. Bir az sonra yenidən cəhd et.", 500);
  } finally { client.release(); }
});

app.post("/api/applications/:id/cancel", lookupLimit, async (req, res) => {
  if (!(await tokenApp(req))) return bad(res, "İcazə yoxdur.", 401);
  const r = await pool.query(
    "UPDATE applications SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('review','info','offer','reoffer') RETURNING id, phone",
    [req.params.id]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, "Müştəri", "cancelled");
  sendResult(req.params.id);
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id} sizin istəyinizlə ləğv edildi. Yeni müraciət üçün:${SITE_URL ? " " + SITE_URL : " *5665"}`);
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
  const done = await pool.query(
    `UPDATE applications SET status = $2, updated_at = now(),
       offer = CASE WHEN $3::jsonb IS NULL THEN offer ELSE jsonb_set(offer, '{final}', $3::jsonb) END
     WHERE id = $1 AND status = 'offer' RETURNING phone`, [req.params.id, d, final]);
  if (!done.rowCount) return bad(res, "Təklif tapılmadı.", 404);
  await logEvent(pool, req.params.id, "Müştəri", d, final);
  sendResult(req.params.id);
  if (d === "accepted") announceAccepted(req.params.id).catch(e => console.error(e.message));
  else notify(req.params.id, done.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id} üzrə təklifdən imtina etdiniz, müraciət bağlandı. Fikrinizi dəyişsəniz, *5665 nömrəsinə zəng edin.`);
  res.json({ ok: true, final });
});

/* ---------- staff ---------- */
// Staff sign in with their own username and password; the panel then sends a 12-hour session key.
const admin = async (req, res, next) => {
  const t = String(req.get("x-admin-token") || "");
  // A session ends 12 hours after sign-in, or earlier after STAFF_IDLE_MINUTES without activity.
  const { rows } = t.length < 20 ? { rows: [] } : await pool.query(
    `UPDATE staff_sessions s SET last_seen = now() FROM staff_users u
     WHERE s.token_hash = $1 AND u.id = s.user_id AND u.active AND s.expires_at > now()
       AND s.last_seen > now() - make_interval(mins => $2::int)
     RETURNING u.id, u.username, u.name, u.role, u.permissions, u.brands`, [sha(t), STAFF_IDLE]);
  // Only failed keys count towards the limit, so expired tabs in a shared office cannot lock out signed-in colleagues.
  if (!rows[0]) return sessionFail(req, res, () => bad(res, "Sessiya bitib, yenidən daxil ol.", 401));
  req.perms = Perms.effective(rows[0]);
  // Brands: a staff member tied to brands (e.g. a BYD sales specialist) sees and is notified only about those brands. Admins see everything.
  const brands = rows[0].role !== "admin" && rows[0].brands?.length ? rows[0].brands : null;
  req.user = { id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role, permissions: req.perms, brands };
  req.staff = rows[0].name;
  next();
};
// Per-application routes: a brand-limited user gets 404 for another brand's application.
const brandGate = async (req, res, next) => {
  if (!req.user.brands) return next();
  const r = await pool.query("SELECT 1 FROM applications WHERE id = $1 AND brand = ANY($2)", [req.params.id, req.user.brands]);
  return r.rowCount ? next() : bad(res, "Müraciət tapılmadı.", 404);
};
const adminOnly = (req, res, next) => req.user.role === "admin" ? next() : bad(res, "Bu əməliyyat yalnız admin üçündür.", 403);
const can = perm => (req, res, next) => req.perms.includes(perm) ? next() : bad(res, "Bu əməliyyat üçün icazən yoxdur.", 403);
const ROLES = ["admin", "expert", "sales"];
// Brands offered on the application form (public/index.html CATALOG). Staff can be tied to some of them.
// Brands on sale; Ford, Honda and Subaru are service only.
const BRANDS = ["Toyota", "Mitsubishi", "Mazda", "BYD"];
// Optional staff mobile for notifications: empty clears it, otherwise 994XXXXXXXXX.
function staffPhone(v) {
  if (v === undefined) return undefined;
  const p = normPhone(v); if (!p) return "";
  const full = p.length === 9 ? "994" + p : p;
  return /^994\d{9}$/.test(full) ? full : null;
}

app.post("/api/admin/login", adminFail, userFail, async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase().slice(0, 64);
  const { rows } = await pool.query("SELECT id, name, role, password_hash, active FROM staff_users WHERE username = $1", [username]);
  const u = rows[0];
  // Same answer, and the same time, for an unknown user and a wrong password.
  const ok = await checkPassword(req.body?.password, u?.password_hash || DUMMY_HASH);
  if (!u || !u.active || !ok) {
    audit(req, username, "login.fail");
    return bad(res, "İstifadəçi adı və ya parol yanlışdır.", 401);
  }
  adminFail.forgive(req); userFail.forgive(req);
  audit(req, username, "login");
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO staff_sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '12 hours')", [sha(token), u.id]);
  await pool.query("UPDATE staff_users SET last_login = now() WHERE id = $1", [u.id]);
  await pool.query("DELETE FROM staff_sessions WHERE expires_at < now()");
  res.json({ token, user: { username, name: u.name, role: u.role } });
});

app.post("/api/admin/logout", admin, async (req, res) => {
  await pool.query("DELETE FROM staff_sessions WHERE token_hash = $1", [sha(req.get("x-admin-token"))]);
  audit(req, req.user.username, "logout");
  res.json({ ok: true });
});

app.get("/api/admin/me", admin, (req, res) => res.json(req.user));

app.post("/api/admin/me/password", admin, async (req, res) => {
  const { rows } = await pool.query("SELECT password_hash FROM staff_users WHERE id = $1", [req.user.id]);
  if (!(await checkPassword(req.body?.current, rows[0].password_hash))) return bad(res, "Hazırkı parol yanlışdır.");
  const w = weakPassword(req.body?.next, req.user.username); if (w) return bad(res, w);
  await pool.query("UPDATE staff_users SET password_hash = $2 WHERE id = $1", [req.user.id, hashPassword(req.body.next)]);
  audit(req, req.user.username, "password.change");
  // Other devices are signed out; this one keeps its session.
  await pool.query("DELETE FROM staff_sessions WHERE user_id = $1 AND token_hash <> $2", [req.user.id, sha(req.get("x-admin-token"))]);
  res.json({ ok: true });
});

/* ---------- SMS provider settings (admin only) ---------- */
// Softline credentials are typed once in the panel and kept in the settings table. The key never goes back to the browser.
const SL_FIELDS = { user: "softline_user", key: "softline_key", sender: "softline_sender" };
async function loadSmsSettings() {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key = ANY($1)", [Object.values(SL_FIELDS)]);
  const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
  Sms.setSoftline({ user: v.softline_user, key: v.softline_key, sender: v.softline_sender });
}
const smsState = () => ({ connected: Sms.configured(), provider: Sms.provider(), ...Sms.softlineInfo() });
app.get("/api/admin/settings/sms", admin, adminOnly, (_req, res) => res.json(smsState()));
app.post("/api/admin/settings/sms", admin, adminOnly, async (req, res) => {
  const b = req.body || {};
  const user = String(b.user || "").trim(), key = String(b.key || "").trim(), sender = String(b.sender || "").trim();
  if (!/^[\w.@-]{2,64}$/.test(user)) return bad(res, "Softline istifadəçi adını yaz.");
  if (!key && !Sms.softlineInfo().keySet) return bad(res, "Softline açarını yaz.");
  if (key && (key.length < 4 || key.length > 200)) return bad(res, "Açar düzgün deyil.");
  if (sender && !/^[\w .-]{2,11}$/.test(sender)) return bad(res, "Göndərən adı 2–11 latın simvolu olmalıdır.");
  const vals = { user, key, sender };
  for (const [f, k] of Object.entries(SL_FIELDS)) if (vals[f])
    await pool.query("INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()", [k, vals[f], req.user.username]);
  Sms.setSoftline(vals);
  audit(req, req.user.username, "settings.sms", key ? "açar yeniləndi" : "açar dəyişmədi");
  res.json(smsState());
});

/* ---------- partner webhook (e.g. Bitrix / Group Motors): the final credit result goes back with the partner's ref number ---------- */
// The address and token are typed once in the panel (settings table). The address carries the token too, so neither goes back to the browser.
const WH = { url: "", token: "", last: null };
async function loadWebhookSettings() {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('partner_webhook_url','partner_webhook_token')");
  const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
  WH.url = v.partner_webhook_url || ""; WH.token = v.partner_webhook_token || "";
}
const whState = () => ({ connected: !!WH.url, host: WH.url ? new URL(WH.url).host : "", tokenSet: !!WH.token, last: WH.last,
  stock: { at: STOCK.at, error: STOCK.error, count: Object.values(STOCK.brands).reduce((n, l) => n + l.reduce((k, g) => k + g.trims.length, 0), 0) } });
// Three events go to the partner, keyed by its ref number (external_id). No FİN or other personal data is sent.
//   submitted: external_id, application_id, date
//   approved:  the same plus terms (credit amount, down payment, months, monthly payment, interest rate)
//   rejected:  external_id, application_id, date
// Every result is sent to the partner (Bitrix): sent to sales, rejected, declined by the customer, cancelled.
const WH_EVENT = { review: "submitted", offer: "approved", rejected: "rejected", accepted: "accepted", declined: "declined", cancelled: "cancelled" };
// `only` sends one given event instead of the one for the current status (used when a ref is added afterwards).
async function postResult(id, attempt = 1, only = null) {
  if (!WH.url) return;
  const { rows } = await pool.query("SELECT id, partner_ref, status, offer, phone, created_at, updated_at FROM applications WHERE id = $1", [id]);
  const a = rows[0];
  const event = a && (only || WH_EVENT[a.status]);
  if (!a || !a.partner_ref || !event) return;
  const r2 = x => Math.round(x * 100) / 100;
  const body = { event, external_id: a.partner_ref, application_id: a.id, date: new Date(event === "submitted" ? a.created_at : a.updated_at).toISOString(),
                 phone: "+" + a.phone };
  if ((event === "approved" || event === "accepted") && a.offer) {
    const o = a.offer, t = finalTerms(o, event === "accepted" ? (o.final?.downPct ?? o.downPct) : o.downPct);
    body.terms = { amount: r2(t.credit), car_price: o.price, down_payment: r2(t.down), down_payment_pct: t.dp, months: t.months,
                   monthly_payment: r2(t.pay), interest_rate: o.rate };
  }
  let error = null;
  try {
    const res = await fetch(WH.url, { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", ...(WH.token ? { "X-Api-Key": WH.token } : {}) }, body: JSON.stringify(body) });
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) { error = e.name === "TimeoutError" ? "cavab gəlmədi (10 san.)" : "qoşulmaq olmadı"; }
  WH.last = { ok: !error, at: new Date().toISOString(), id, error };
  await logEvent(pool, id, "Sistem", "webhook", { result: event, ref: a.partner_ref, ...(error ? { error } : {}) }).catch(() => {});
  if (error) { console.error(`Partnyor webhook xətası (${id}): ${error}`); if (attempt < 2) setTimeout(() => postResult(id, attempt + 1, only).catch(() => {}), 60000); }
}
const sendResult = id => postResult(id).catch(e => console.error(e.message));

// "Tarixçə və qeydlər" go to the partner (Bitrix) as event "history" (see lib/history.js), ~15 s after the last change
// of an application, so a burst of events goes as one call.
const historyTimers = new Map();
function queueHistory(id) {
  if (!WH.url || !id) return;
  clearTimeout(historyTimers.get(id));
  historyTimers.set(id, setTimeout(() => { historyTimers.delete(id); postHistory(id).catch(e => console.error(e.message)); }, HISTORY_DELAY).unref());
}
const HISTORY_DELAY = Number(process.env.HISTORY_DELAY_MS) || 15000;
async function postHistory(id, attempt = 1) {
  if (!WH.url) return;
  const body = await History.build(pool, id); if (!body) return;
  const error = await History.post(WH, body);
  WH.last = { ok: !error, at: new Date().toISOString(), id, error, event: "history" };
  if (error && attempt < 3) setTimeout(() => postHistory(id, attempt + 1).catch(() => {}), attempt * 60e3).unref();
}


// Stock and prices come from the same partner, with the same token: GET {origin}/credit/kb/{token}, refreshed every 15 minutes.
// The last good list is kept if the partner is unreachable.
const STOCK = { brands: {}, at: null, error: null };
async function loadStock() {
  if (!WH.url || !WH.token) { STOCK.brands = {}; STOCK.at = null; STOCK.error = null; return; }
  try {
    // The partner returns at most `limit` chunks (default 200, capped by them), so ask brand by brand:
    // one call to find which brands it has, then each brand with a high limit.
    const base = `${new URL(WH.url).origin}/credit/kb/${encodeURIComponent(WH.token)}`;
    const get = async q => {
      const r = await fetch(`${base}?${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Array.isArray(j.chunks) ? j.chunks : [];
    };
    const first = await get({ limit: 1000 });
    const slugs = new Set([...BRANDS.map(b => b.toLowerCase()), ...first.map(c => String(c.brand || "").toLowerCase())]);
    slugs.delete(""); slugs.delete("common");
    const byId = new Map(first.map(c => [c.id, c]));
    for (const slug of slugs)
      for (const c of await get({ brand: slug, limit: 5000 }))
        if (String(c.brand || "").toLowerCase() === slug) byId.set(c.id, c);
    STOCK.brands = Stock.parse([...byId.values()], BRANDS); STOCK.at = new Date().toISOString(); STOCK.error = null;
  } catch (e) { STOCK.error = e.name === "TimeoutError" ? "cavab gəlmədi" : e.message; console.error(`Stok yüklənmədi: ${STOCK.error}`); }
}
app.get("/api/stock", (_req, res) => res.json({ at: STOCK.at, brands: STOCK.brands }));

app.get("/api/admin/settings/webhook", admin, adminOnly, (_req, res) => res.json(whState()));
app.post("/api/admin/settings/webhook", admin, adminOnly, async (req, res) => {
  const url = String(req.body?.url || "").trim(), token = String(req.body?.token || "").trim();
  if (req.body?.clear) {
    await pool.query("DELETE FROM settings WHERE key IN ('partner_webhook_url','partner_webhook_token')");
    WH.url = ""; WH.token = ""; WH.last = null; loadStock();
    audit(req, req.user.username, "settings.webhook", "söndürüldü");
    return res.json(whState());
  }
  if (!url && !WH.url) return bad(res, "Webhook ünvanını yaz.");
  if (url) { let u; try { u = new URL(url); } catch { return bad(res, "Ünvan düzgün deyil."); }
    const local = u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname); // only for tests on the server itself
    if ((u.protocol !== "https:" && !local) || url.length > 500) return bad(res, "Ünvan https:// ilə başlamalıdır."); }
  if (token && (token.length < 8 || token.length > 200)) return bad(res, "Token düzgün deyil.");
  for (const [k, v] of [["partner_webhook_url", url], ["partner_webhook_token", token]]) if (v)
    await pool.query("INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()", [k, v, req.user.username]);
  if (url) WH.url = url; if (token) WH.token = token;
  await loadStock();
  audit(req, req.user.username, "settings.webhook", url ? "ünvan yeniləndi" : "token yeniləndi");
  res.json(whState());
});

/* ---------- robocall integration: robocall pulls application data and calls customers ---------- */
// The token is generated in the panel and shown once; only its sha256 is stored. Robocall sends it as X-Integration-Token.
// No interest rate goes out (the bot must never mention it), and FİN is masked. "Digər xərclər" (DYP, KASKO, GPS, bank
// commission) go out in AZN as terms.other_costs, because the customer is told about them.
const RC = { hash: "", lastPull: null };
async function loadRobocallSettings() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'robocall_token_hash'");
  RC.hash = rows[0]?.value || "";
}
// The other direction: ARZOOM calls ArzoomCall's external API (re-queue a customer, fetch a recording) with an API key
// created in the ArzoomCall panel. The key is stored here, used only server-side and never sent back or logged.
const RCAPI = { base: "", key: "" };
async function loadRcApi() {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('arzoomcall_api_base','arzoomcall_api_key')");
  for (const r of rows) RCAPI[r.key === "arzoomcall_api_base" ? "base" : "key"] = r.value;
}
const rcApi = (path, opts = {}) => {
  if (!RCAPI.base || !RCAPI.key) throw Object.assign(new Error("ArzoomCall API qoşulmayıb: İstifadəçilər → ArzoomCall inteqrasiyası bölməsində ünvanı və API açarını yazın."), { status: 409 });
  return fetch(RCAPI.base.replace(/\/+$/, "") + path, { ...opts, signal: AbortSignal.timeout(opts.timeout || 15000),
    headers: { Authorization: `Bearer ${RCAPI.key}`, ...(opts.headers || {}) } });
};
const rcState = () => ({ tokenSet: !!RC.hash, lastPull: RC.lastPull, endpoint: (SITE_URL || "") + "/api/integrations/robocall/applications",
                         api: { base: RCAPI.base, keySet: !!RCAPI.key } });
app.post("/api/admin/settings/robocall/api", admin, adminOnly, async (req, res) => {
  const base = String(req.body?.base || "").trim(), key = String(req.body?.key || "").trim();
  if (base && !/^https?:\/\/[^\s/?#]+(:\d+)?\/?$/.test(base)) return bad(res, "Ünvan http(s)://host:port formasında olmalıdır, məs. http://172.17.0.1:4000");
  if (key && key.length < 16) return bad(res, "API açarı çox qısadır.");
  const set = (k, v) => v ? pool.query("INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()", [k, v, req.user.username])
                          : pool.query("DELETE FROM settings WHERE key = $1", [k]);
  await set("arzoomcall_api_base", base);
  if (key || !base) await set("arzoomcall_api_key", base ? key : "");
  RCAPI.base = base; if (key || !base) RCAPI.key = base ? key : "";
  audit(req, req.user.username, "settings.robocall", base ? "API ünvanı və açarı" : "API söndürüldü");
  res.json(rcState());
});
app.get("/api/admin/settings/robocall", admin, adminOnly, (_req, res) => res.json(rcState()));
app.post("/api/admin/settings/robocall", admin, adminOnly, async (req, res) => {
  if (req.body?.clear) {
    await pool.query("DELETE FROM settings WHERE key = 'robocall_token_hash'");
    RC.hash = ""; RC.lastPull = null;
    audit(req, req.user.username, "settings.robocall", "söndürüldü");
    return res.json(rcState());
  }
  const token = "rc_" + crypto.randomBytes(24).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query("INSERT INTO settings (key, value, updated_by) VALUES ('robocall_token_hash',$1,$2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()", [hash, req.user.username]);
  RC.hash = hash;
  audit(req, req.user.username, "settings.robocall", "yeni token");
  res.json({ ...rcState(), token });
});
/* ---------- income document analysis on the server (OCR): the expert presses "Analiz et" on a document ---------- */
// The file never leaves the server: PDF text layer or Tesseract OCR, then rules. At most two run at once (OCR is CPU heavy).
let aiRunning = 0;
const aiBusy = new Set();
app.post("/api/admin/applications/:id/files/:fileId/analyze", admin, brandGate, can("apps.assess"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.stored_name, f.mime, f.income_source, f.doc_label, f.original_name, a.fin, a.created_at, a.bureau->'borrower'->>'name' AS bname,
            a.assessment->'inputs'->>'incomeMonthly' AS income
     FROM application_files f JOIN applications a ON a.id = f.application_id WHERE f.application_id = $1 AND f.id = $2`,
    [req.params.id, Number(req.params.fileId) || 0]);
  const f = rows[0];
  if (!f) return bad(res, "Sənəd tapılmadı.", 404);
  if (aiBusy.has(f.id)) return bad(res, "Bu sənəd artıq analiz olunur.", 409);
  if (aiRunning >= 2) return bad(res, "Server başqa sənədləri oxuyur, bir neçə saniyədən sonra yenidən basın.", 429);
  aiBusy.add(f.id); aiRunning++;
  try {
    const result = await Ocr.analyze({
      filePath: path.join(UPLOAD_DIR, path.basename(f.stored_name)), mime: f.mime,
      applicant: { name: f.bname, fin: f.fin, declaredIncome: Number(f.income) || null }
    });
    const analysis = { ...result, at: new Date().toISOString(), by: req.staff };
    await pool.query("UPDATE application_files SET analysis = $2 WHERE id = $1", [f.id, analysis]);
    await logEvent(pool, req.params.id, req.staff, "doc_analysis",
      { file: fixName(f.original_name), doc: result.doc_type_label, avg: result.avg_monthly_net, flags: result.red_flags.length });
    res.json(analysis);
  } catch (e) {
    if (!e.status) console.error("Sənəd analizi xətası:", e.message);
    bad(res, e.status ? e.message : "Analiz alınmadı.", e.status || 500);
  } finally { aiBusy.delete(f.id); aiRunning--; }
});
const RC_STATUS = { review: "Baxılır", info: "Əlavə sənəd gözlənilir", offer: "Təklif göndərilib", reoffer: "Təklif yenidən hazırlanır", rejected: "Rədd edilib",
                    accepted: "Satışa ötürülüb", declined: "Müştəri imtina etdi", cancelled: "Müştəri ləğv etdi" };
const rcFail = rateLimit({ windowMs: 15 * 60e3, max: 20, message: "Çox sayda uğursuz sorğu." });
// Changes in order of (changed_at, id): changed_at is the later of the row's update and its last event (notes, replies),
// so call results and customer replies also show up. Deleted applications come as { id, deleted: true }.
const rcAuth = (req, res, next) => {
  const got = crypto.createHash("sha256").update(String(req.get("x-integration-token") || "")).digest("hex");
  if (!RC.hash || !sameHex(got, RC.hash)) return rcFail(req, res, () => bad(res, "İcazə yoxdur.", 401));
  next();
};
// The customer's final word from a robocall call. Stored as a call note (channel "robocall"), so it shows in the panel
// timeline and comes back in last_call. feedback_id makes repeats harmless: robocall retries until it gets 200.
// The customer is interested but not with these terms: the application goes to "Təkrar təklif" for staff to rework the offer.
const REOFFER_OUTCOMES = new Set(["wants_lower_monthly", "wants_lower_down", "wants_other_terms"]);
app.post("/api/integrations/robocall/applications/:id/feedback", rcAuth, async (req, res) => {
  const b = req.body || {};
  const feedback_id = String(b.feedback_id || "").trim().slice(0, 120);
  if (!feedback_id) return bad(res, "feedback_id lazımdır.");
  const outcome = String(b.outcome || "");
  if (!Object.hasOwn(ROBO_RESULTS, outcome)) return bad(res, "outcome düzgün deyil.");
  const r = await pool.query("SELECT 1 FROM applications WHERE id = $1", [req.params.id]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  const label = String(b.outcome_label || "").trim().slice(0, 120) || ROBO_RESULTS[outcome];
  const details = { outcome, outcome_label: label, channel: "robocall", text: b.reason ? String(b.reason).trim().slice(0, 2000) : "",
                    feedback_id, call_ref: b.call_ref ? String(b.call_ref).slice(0, 120) : null,
                    call_at: !isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : null,
                    // amounts the customer asked for, if robocall caught them (e.g. monthly payment, down payment %)
                    requested_terms: b.requested_terms && typeof b.requested_terms === "object" && !Array.isArray(b.requested_terms)
                      && JSON.stringify(b.requested_terms).length <= 500 ? b.requested_terms : null };
  const ins = await pool.query(
    `INSERT INTO application_events (application_id, actor, kind, details) VALUES ($1, 'ArzoomCall', 'note', $2)
     ON CONFLICT ((details->>'feedback_id')) WHERE kind = 'note' AND details ? 'feedback_id' DO NOTHING`, [req.params.id, details]);
  if (ins.rowCount) queueHistory(req.params.id);
  let reoffer = false;
  if (ins.rowCount && REOFFER_OUTCOMES.has(outcome)) {
    const request = { outcome, label, reason: details.text || null, requested_terms: details.requested_terms, at: new Date().toISOString(), source: "robocall" };
    const u = await pool.query(`UPDATE applications SET status = 'reoffer', reoffer = $2, updated_at = now()
                                WHERE id = $1 AND status IN ('offer','declined','cancelled') RETURNING id`, [req.params.id, request]);
    if (u.rowCount) { reoffer = true; await logEvent(pool, req.params.id, "ArzoomCall", "reoffer", request); }
  }
  // The bot put the customer through to a sales representative: the application is handed to sales.
  const sales = ins.rowCount && outcome === "transferred_to_sales" ? await robotToSales(req.params.id) : false;
  res.json({ ok: true, duplicate: !ins.rowCount, reoffer, sales });
});
// An application with an offer goes to "Satışa ötürülüb" once ArzoomCall connected the customer to a sales representative.
// The offered down payment stands as the final one; staff and the partner are told as when the customer confirms online.
// The customer gets no "you confirmed" SMS, since they spoke to sales on the line.
async function robotToSales(id, { announce = true } = {}) {
  const u = await pool.query(
    `UPDATE applications SET status = 'accepted', updated_at = now(),
       offer = jsonb_set(offer, '{final}', jsonb_build_object('downPct', offer->'downPct', 'at', now(), 'source', 'robocall'))
     WHERE id = $1 AND status IN ('offer','reoffer') AND offer ? 'downPct' RETURNING offer->'final' AS final`, [id]);
  if (!u.rowCount) return false;
  await logEvent(pool, id, "ArzoomCall", "accepted", { ...u.rows[0].final, via: "robocall" });
  sendResult(id);
  if (announce) announceAccepted(id, { customer: false }).catch(e => console.error(e.message));
  return true;
}
// Applications whose customer was already put through to sales before this rule existed are moved once at start-up (no SMS).
async function backfillRobotSales() {
  const { rows } = await pool.query(
    `SELECT DISTINCT a.id FROM applications a JOIN application_events e ON e.application_id = a.id
     WHERE a.status IN ('offer','reoffer') AND e.kind = 'note' AND e.details->>'channel' = 'robocall'
       AND e.details->>'outcome' = 'transferred_to_sales'`);
  for (const r of rows) await robotToSales(r.id, { announce: false });
  if (rows.length) console.log(`ArzoomCall: ${rows.length} müraciət satışa ötürüldü (əvvəlki zənglər).`);
}
// Call analytics from ArzoomCall: a full snapshot after every call and every 5 minutes; only the newest is kept.
let callStats = null;
async function loadCallStats() {
  if (callStats) return callStats;
  const { rows } = await pool.query("SELECT value, updated_at FROM settings WHERE key = 'arzoomcall_analytics'");
  if (rows[0]) try { callStats = { ...JSON.parse(rows[0].value), received_at: rows[0].updated_at }; } catch { callStats = null; }
  return callStats;
}
const PERIOD_KEYS = ["today", "week", "month"];
app.post("/api/integrations/robocall/analytics", rcAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.periods || typeof b.periods !== "object" || !PERIOD_KEYS.some(k => b.periods[k] && typeof b.periods[k] === "object"))
    return bad(res, "periods lazımdır.");
  const snap = { source: "arzoomcall", generated_at: !isNaN(Date.parse(b.generated_at)) ? new Date(b.generated_at).toISOString() : new Date().toISOString(),
                 periods: Object.fromEntries(PERIOD_KEYS.filter(k => b.periods[k]).map(k => [k, b.periods[k]])),
                 recent_calls: Array.isArray(b.recent_calls) ? b.recent_calls.filter(c => c && typeof c === "object").slice(0, 1000) : [] };
  const value = JSON.stringify(snap);
  await pool.query(`INSERT INTO settings (key, value, updated_by) VALUES ('arzoomcall_analytics', $1, 'ArzoomCall')
                    ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = 'ArzoomCall', updated_at = now()`, [value]);
  callStats = { ...snap, received_at: new Date().toISOString() };
  res.json({ ok: true });
});
app.get("/api/admin/call-analytics", admin, can("analytics.view"), async (_req, res) => {
  const s = await loadCallStats();
  if (!s) return res.json({ empty: true });
  const { recent_calls, ...rest } = s;
  // Each extension may list the applications put through to it; their current status comes from ARZOOM. Only ids and times are kept.
  const periods = {}, ids = new Set();
  for (const [k, p] of Object.entries(rest.periods || {})) {
    const transfers = Array.isArray(p?.transfers) ? p.transfers.map(t => {
      const calls = (Array.isArray(t?.calls) ? t.calls : []).filter(c => c && /^[\w-]{1,40}$/.test(String(c.application_id || ""))).slice(0, 50)
        .map(c => ({ application_id: String(c.application_id), at: !isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : null, answered: c.answered !== false }));
      calls.forEach(c => ids.add(c.application_id));
      return { ...t, calls };
    }) : p?.transfers;
    periods[k] = { ...p, transfers };
  }
  if (ids.size) {
    const { rows } = await pool.query("SELECT id, status, updated_at FROM applications WHERE id = ANY($1)", [[...ids]]);
    const st = new Map(rows.map(r => [r.id, r]));
    for (const p of Object.values(periods)) for (const t of p.transfers || []) for (const c of t.calls || []) {
      const a = st.get(c.application_id); c.status = a?.status || null; c.status_at = a?.updated_at || null;
    }
  }
  res.json({ ...rest, periods, calls_total: (recent_calls || []).length });
});
// The bot hung up without recording a result; ArzoomCall inferred "other" afterwards. These customers need another call.
const unrecorded = c => c.outcome === "other" && /^(Zəngdən avtomatik çıxarılıb|Bot zəng zamanı nəticəni qeyd etməyib)/.test(String(c.reason || ""));
// A customer already talked to (any call with a real result) is not listed for another call, so their answer stands.
const needsCall = all => { const talked = new Set(all.filter(c => c.application_id && c.outcome && !unrecorded(c)).map(c => c.application_id));
  return c => unrecorded(c) && !(c.application_id && talked.has(c.application_id)); };
// The conversations of the snapshot (up to 90 days), filtered and paged (25 a page) on the server; phone numbers are not sent.
app.get("/api/admin/call-analytics/calls", admin, can("analytics.view"), async (req, res) => {
  const all = (await loadCallStats())?.recent_calls || [];
  const q = String(req.query.q || "").trim().toLocaleLowerCase("az").slice(0, 80), outcome = String(req.query.outcome || ""), ans = String(req.query.answered || "");
  const per = 25, page = Math.max(1, parseInt(req.query.page, 10) || 1), need = needsCall(all);
  const rows = all.filter(c => (!q || `${c.customer_name || ""} ${c.application_id || ""}`.toLocaleLowerCase("az").includes(q))
    && (outcome === "unrecorded" ? need(c) : !outcome || c.outcome === outcome) && (ans === "" || !!c.answered === (ans === "1")));
  const outcomes = [...new Map(all.filter(c => c.outcome).map(c => [c.outcome, c.outcome_label || c.outcome])).entries()].map(([outcome, label]) => ({ outcome, label }));
  res.json({ total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / per)), outcomes, unrecorded: all.filter(need).length,
             items: rows.slice((page - 1) * per, page * per).map(({ phone, ...c }) => c) });
});
// "Yenidən zəng et": ArzoomCall puts the customer back in its queue; the call starts within about a minute.
app.post("/api/admin/applications/:id/requeue-call", admin, brandGate, can("apps.assess"), async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM applications WHERE id = $1", [req.params.id]);
  if (!rows[0]) return bad(res, "Müraciət tapılmadı.", 404);
  let r, body = {};
  try {
    r = await rcApi("/api/external/v1/arzoom/requeue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ application_id: req.params.id }) });
    body = await r.json().catch(() => ({}));
  } catch (e) { return bad(res, e.status ? e.message : "ArzoomCall cavab vermədi.", e.status || 502); }
  const MSG = { 404: "ArzoomCall bu müraciəti tanımır.", 409: "Bu statusda və ya kampaniyasız müştəriyə zəng edilmir.", 401: "ArzoomCall API açarı yanlışdır.", 400: "Sorğu düzgün deyil." };
  if (!r.ok) return bad(res, MSG[r.status] || `ArzoomCall xətası (${r.status}).`, r.status === 401 ? 502 : r.status >= 500 ? 502 : r.status);
  await logEvent(pool, req.params.id, req.staff, "call_requeue", { queued: body.queued ?? null, note: body.note ? String(body.note).slice(0, 200) : null });
  res.json({ ok: true, queued: body.queued ?? 0, note: body.note || null });
});
// A call recording, fetched from ArzoomCall on the server so the recording never needs a public address.
app.get("/api/admin/call-analytics/calls/:callId/recording", admin, can("analytics.view"), async (req, res) => {
  const id = String(req.params.callId);
  if (!/^[\w-]{1,64}$/.test(id)) return bad(res, "Zəng tapılmadı.", 404);
  let r;
  try { r = await rcApi(`/api/external/v1/arzoom/recordings/${encodeURIComponent(id)}`, { timeout: 30000, headers: req.get("range") ? { Range: req.get("range") } : {} }); }
  catch (e) { return bad(res, e.status ? e.message : "ArzoomCall cavab vermədi.", e.status || 502); }
  if (r.status === 404) return bad(res, "Bu zəngin səs yazısı yoxdur.", 404);
  if (!r.ok && r.status !== 206) return bad(res, `Səs yazısı alınmadı (${r.status}).`, 502);
  const type = r.headers.get("content-type") || "";
  if (!/^audio\//.test(type)) return bad(res, "Səs yazısı alınmadı.", 502);
  res.status(r.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) if (r.headers.get(h)) res.set(h, r.headers.get(h));
  audit(req, req.user.username, "call.recording", id);
  require("stream").Readable.fromWeb(r.body).pipe(res);
});
// Campaign calls to people who are not applicants yet: when they agree, ArzoomCall asks ARZOOM to text them the link
// to the application form (ArzoomCall has no SMS provider). One SMS per number per 24 h and LINK_SMS_DAILY_MAX (500)
// a day in all. The number is kept only as a hash (for the 24 h check) and masked; the text carries no name.
const LINK_DAILY = Number(process.env.LINK_SMS_DAILY_MAX) || 500;
app.post("/api/integrations/robocall/send-application-link", rcAuth, async (req, res) => {
  const b = req.body || {}, p = normPhone(b.phone), phone = p.length === 9 ? "994" + p : p;
  if (!/^994\d{9}$/.test(phone)) return bad(res, "Mobil nömrə düzgün deyil (994XXXXXXXXX).");
  const brand = BRANDS.find(x => x.toLowerCase() === String(b.brand || "").trim().toLowerCase()) || null;
  const source = /^[a-z0-9_-]{1,32}$/.test(String(b.source ?? "")) ? String(b.source) : "robocall";
  if (!SITE_URL) return bad(res, "Saytın ünvanı (SITE_ADDRESS) təyin olunmayıb.", 503);
  if (!Sms.configured()) return bad(res, "SMS provayderi qoşulmayıb.", 503);
  const hash = sha("link:" + phone);
  const recent = await pool.query("SELECT at FROM link_sms WHERE phone_hash = $1 AND error IS NULL AND at > now() - interval '24 hours' ORDER BY at DESC LIMIT 1", [hash]);
  if (recent.rowCount) return res.status(429).json({ error: "Bu nömrəyə son 24 saatda link göndərilib.", duplicate: true,
    retry_after: new Date(recent.rows[0].at.getTime() + 864e5).toISOString() });
  const day = await pool.query("SELECT count(*)::int AS n FROM link_sms WHERE error IS NULL AND at > now() - interval '24 hours'");
  if (day.rows[0].n >= LINK_DAILY) return bad(res, "Günlük SMS limiti dolub.", 429);
  const text = `Arzoom Avto: ${brand ? brand + " avtomobilini" : "Avtomobili"} lizinqə almaq üçün müraciəti bu linkdən göndərin: ${SITE_URL}/?partner=arzoomcall`;
  let error = null;
  try { await sendSms(phone, text); } catch (e) { error = String(e.message || "göndərilmədi").slice(0, 200); }
  const r = await pool.query("INSERT INTO link_sms (phone_hash, phone_masked, brand, source, error) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [hash, maskPhone(phone), brand, source, error]);
  if (error) { console.error(`Link SMS-i göndərilmədi: ${error}`); return bad(res, "SMS göndərilmədi.", 502); }
  res.json({ ok: true, sms_id: String(r.rows[0].id) });
});
app.get("/api/integrations/robocall/applications", rcAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  let since = "1970-01-01T00:00:00Z", afterId = "";
  if (req.query.since) {
    const [t, i = ""] = String(req.query.since).split("|");
    // Only an ISO time is accepted: Date.parse is lenient and lets text like "' OR '1'='1" through to the database.
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(t) || isNaN(Date.parse(t)) || !/^[\w-]{0,64}$/.test(i))
      return bad(res, "since düzgün deyil (ISO tarix və ya next_since).");
    since = t; afterId = i;
  }
  const { rows: page } = await pool.query(
    `WITH items AS (
       SELECT a.id, greatest(a.updated_at, a.created_at, coalesce((SELECT max(e.at) FROM application_events e WHERE e.application_id = a.id), a.created_at)) AS changed_at, false AS deleted
         FROM applications a
       UNION ALL
       SELECT application_id, max(at), true FROM deletion_log GROUP BY application_id)
     SELECT id, deleted, changed_at, to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM items WHERE (changed_at, id) > ($1::timestamptz, $2) ORDER BY changed_at, id LIMIT $3`, [since, afterId, limit + 1]);
  const has_more = page.length > limit; if (has_more) page.pop();
  const ids = page.filter(p => !p.deleted).map(p => p.id);
  const { rows: apps } = ids.length ? await pool.query(
    `SELECT a.id, a.phone, a.status, a.created_at, a.updated_at, a.fin, a.birth_date, a.guarantor, a.brand, a.model, a.car_price, a.income_sources,
            a.partner, a.partner_ref, a.offer, a.reject_public, a.info_request,
            (SELECT jsonb_build_object('outcome', e.details->>'outcome', 'outcome_label', e.details->>'outcome_label', 'channel', e.details->>'channel', 'text', e.details->>'text', 'at', e.at)
               FROM application_events e WHERE e.application_id = a.id AND e.kind = 'note' AND e.details ? 'outcome' ORDER BY e.at DESC LIMIT 1) AS last_call
       FROM applications a WHERE a.id = ANY($1)`, [ids]) : { rows: [] };
  const byId = new Map(apps.map(a => [a.id, a]));
  const r2 = x => Math.round(x * 100) / 100;
  const items = page.map(p => {
    const changed_at = p.cursor_at;
    if (p.deleted) return { id: p.id, deleted: true, changed_at };
    const a = byId.get(p.id); if (!a) return { id: p.id, deleted: true, changed_at };
    const o = a.offer, info = a.status === "info" ? a.info_request : null;
    const terms = dp => { const t = finalTerms(o, dp); return { car_price: o.price, down_payment_pct: t.dp, down_payment: r2(t.down), amount: r2(t.credit), months: t.months, monthly_payment: r2(t.pay), other_costs: Object.fromEntries(Object.entries(t.other).map(([k, v]) => [k, r2(v)])) }; };
    return {
      id: a.id, deleted: false, changed_at, created_at: a.created_at, updated_at: a.updated_at,
      phone: "+" + a.phone, status: a.status, status_label: RC_STATUS[a.status] || a.status,
      fin_masked: "***" + String(a.fin || "").trim().slice(-4), birth_date: a.birth_date ? (a.birth_date instanceof Date ? a.birth_date.toISOString() : String(a.birth_date)).slice(0, 10) : null,
      guarantor: a.guarantor, brand: a.brand, model: a.model, car_price: a.car_price != null ? +a.car_price : (o?.price ?? null),
      income_sources: a.income_sources, partner: a.partner || null, partner_ref: a.partner_ref || null,
      offer: o && ["offer", "reoffer", "accepted", "declined"].includes(a.status) ? terms(o.downPct) : null,
      final_terms: o?.final && a.status === "accepted" ? terms(o.final.downPct) : null,
      info_docs: info ? (info.docs || []).map(d => d.label) : [], info_text: info?.text || null,
      reject_reason: a.status === "rejected" ? a.reject_public || null : null,
      last_call: a.last_call ? { outcome: a.last_call.outcome, outcome_label: a.last_call.outcome_label || CALL_RESULTS[a.last_call.outcome] || a.last_call.outcome,
                                 channel: a.last_call.channel || null, text: a.last_call.text || null, at: a.last_call.at } : null,
      cabinet_url: SITE_URL ? `${SITE_URL}/#muracietlerim` : null
    };
  });
  const last = page[page.length - 1];
  RC.lastPull = new Date().toISOString();
  res.json({ items, has_more, next_since: last ? `${last.cursor_at}|${last.id}` : (req.query.since || null) });
});

app.get("/api/admin/users", admin, adminOnly, async (_req, res) => {
  const { rows } = await pool.query("SELECT id, username, name, role, phone, permissions, brands, active, created_at, last_login FROM staff_users ORDER BY created_at");
  res.json({ users: rows.map(u => ({ ...u, custom: Array.isArray(u.permissions) && u.role !== "admin", permissions: Perms.effective(u) })),
             catalog: Perms.PERMS, defaults: Perms.ROLE_DEFAULTS, brands: BRANDS });
});

app.post("/api/admin/users", admin, adminOnly, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || "").trim().toLowerCase();
  const name = String(b.name || "").trim().slice(0, 60);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return bad(res, "İstifadəçi adı 3–32 simvol: kiçik latın hərfləri, rəqəm, nöqtə, tire.");
  if (!name) return bad(res, "Ad və soyadı yaz.");
  const w = weakPassword(b.password, username); if (w) return bad(res, w);
  const role = ROLES.includes(b.role) ? b.role : "expert";
  const phone = staffPhone(b.phone ?? "");
  if (phone === null) return bad(res, "Mobil nömrə düzgün deyil. Məs. 50 123 45 67");
  const r = await pool.query(
    "INSERT INTO staff_users (username, name, password_hash, role, phone, brands) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username) DO NOTHING RETURNING id",
    [username, name, hashPassword(b.password), role, phone || null, Array.isArray(b.brands) ? [...new Set(b.brands.filter(x => BRANDS.includes(x)))] : []]);
  if (!r.rowCount) return bad(res, "Bu istifadəçi adı artıq var.", 409);
  audit(req, req.user.username, "user.create", `${username} (${role})`);
  res.status(201).json({ id: r.rows[0].id });
});

app.post("/api/admin/users/:id", admin, adminOnly, async (req, res) => {
  const b = req.body || {}, id = +req.params.id;
  if (id === +req.user.id && (b.active === false || (b.role && b.role !== "admin"))) return bad(res, "Öz admin hesabını söndürə və ya rolunu dəyişə bilməzsən.");
  const phone = staffPhone(b.phone);
  if (phone === null) return bad(res, "Mobil nömrə düzgün deyil. Məs. 50 123 45 67");
  if (b.password != null) { const w = weakPassword(b.password); if (w) return bad(res, w); }
  if (b.role != null && !ROLES.includes(b.role)) return bad(res, "Rol düzgün deyil.");
  const r = await pool.query(
    `UPDATE staff_users SET
       active = COALESCE($2, active), role = COALESCE($3, role), password_hash = COALESCE($4, password_hash),
       phone = CASE WHEN $5::text IS NULL THEN phone ELSE NULLIF($5, '') END,
       permissions = CASE WHEN $6 THEN $7::jsonb ELSE permissions END,
       brands = COALESCE($8::text[], brands)
     WHERE id = $1 RETURNING id`,
    [id, typeof b.active === "boolean" ? b.active : null, ROLES.includes(b.role) ? b.role : null,
     b.password != null ? hashPassword(b.password) : null, phone ?? null,
     // permissions: array sets a custom list, null goes back to the role's defaults
     "permissions" in b, Perms.clean(b.permissions) ? JSON.stringify(Perms.clean(b.permissions)) : null,
     Array.isArray(b.brands) ? [...new Set(b.brands.filter(x => BRANDS.includes(x)))] : null]);
  if ("permissions" in b || "brands" in b) await pool.query("DELETE FROM staff_sessions WHERE user_id = $1 AND $1 <> $2", [id, req.user.id]).catch(() => {});
  if (!r.rowCount) return bad(res, "İstifadəçi tapılmadı.", 404);
  if (b.active === false || b.password != null || b.role != null) await pool.query("DELETE FROM staff_sessions WHERE user_id = $1 AND $1 <> $2", [id, req.user.id]);
  const changed = ["active", "role", "phone", "permissions", "brands"].filter(k => k in b).concat(b.password != null ? ["password"] : []);
  audit(req, req.user.username, "user.update", `#${id}: ${changed.join(", ")}`);
  res.json({ ok: true });
});

app.get("/api/admin/audit", admin, adminOnly, async (_req, res) => {
  const { rows } = await pool.query("SELECT at, username, ip, action, target FROM audit_log ORDER BY at DESC, id DESC LIMIT 200");
  res.json({ items: rows });
});

// Period of the list by Baku calendar day: today, yesterday, last 7 or 30 days; anything else means all.
// A search always looks through all applications, whatever the period.
const PERIODS = { today: [0, false], yesterday: [1, true], "7d": [6, false], "30d": [29, false] };
const BAKU_DAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Baku') AT TIME ZONE 'Asia/Baku')";
const periodArgs = (p, q) => { const v = !q && PERIODS[p]; return v ? v : [null, false]; };
const PERIOD_SQL = (a, b) => `($${a}::int IS NULL OR (created_at >= ${BAKU_DAY} - make_interval(days => $${a}::int) AND ($${b}::boolean IS NOT TRUE OR created_at < ${BAKU_DAY})))`;
app.get("/api/admin/applications", admin, async (req, res) => {
  const q = String(req.query.q || "").trim().toUpperCase().slice(0, 64);
  const st = String(req.query.status || "");
  const [pDays, pEnd] = periodArgs(String(req.query.period || ""), q);
  const { rows } = await pool.query(
    `SELECT id, created_at, updated_at, fin, phone, partner, partner_ref, brand, model, income_sources, status,
            assessment->'result'->>'grade' AS grade, (assessment->'result'->>'score')::int AS score, ${LAST_CALL} AS last_call
     FROM applications
     WHERE ($1 = '' OR status = $1)
       AND ($2 = '' OR id ILIKE '%' || $2 || '%' OR fin ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%' OR upper(model) LIKE '%' || $2 || '%' OR upper(partner_ref) = $2)
       AND ($3::text[] IS NULL OR brand = ANY($3))
       AND ${PERIOD_SQL(4, 5)}
     ORDER BY created_at DESC LIMIT 500`, [st, q, req.user.brands, pDays, pEnd]);
  const counts = await pool.query(`SELECT status, count(*)::int AS n FROM applications WHERE ($1::text[] IS NULL OR brand = ANY($1)) AND ${PERIOD_SQL(2, 3)} GROUP BY status`,
    [req.user.brands, pDays, pEnd]);
  res.json({ items: rows, counts: Object.fromEntries(counts.rows.map(r => [r.status, r.n])) });
});

/* ---------- Excel export ---------- */
// All applications (or the current filter) as .xlsx. Holds personal data, so it needs its own permission and is audited.
app.get("/api/admin/export.xlsx", admin, async (req, res) => {
  if (!req.perms.includes("apps.export")) return bad(res, "Excel-ə çıxarmaq üçün icazən yoxdur.", 403);
  const q = String(req.query.q || "").trim().toUpperCase().slice(0, 64);
  const st = String(req.query.status || "");
  const [pDays, pEnd] = periodArgs(String(req.query.period || ""), q);
  const { rows } = await pool.query(
    `SELECT id, created_at, updated_at, status, fin, id_series, id_number, birth_date::text AS birth_date, phone, partner, partner_ref, income_sources, voen, brand, model, guarantor,
            assessment->'result'->>'grade' AS grade, (assessment->'result'->>'score')::int AS score, offer, reject_public, decided_by,
            ${LAST_CALL} AS last_call
     FROM applications
     WHERE ($1 = '' OR status = $1)
       AND ($2 = '' OR id ILIKE '%' || $2 || '%' OR fin ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%' OR upper(model) LIKE '%' || $2 || '%' OR upper(partner_ref) = $2)
       AND ($3::text[] IS NULL OR brand = ANY($3))
       AND ${PERIOD_SQL(4, 5)}
     ORDER BY created_at DESC`, [st, q, req.user.brands, pDays, pEnd]);
  const cols = [["Müraciət №", 14], ["Daxil olub", 17], ["Status", 18], ["FİN", 10], ["Şəxsiyyət vəsiqəsi", 16], ["Doğum tarixi", 12],
    ["Telefon", 15], ["Partnyor", 14], ["Partnyor ref №", 14], ["Gəlir mənbələri", 28], ["VÖEN", 12], ["Marka", 14], ["Model", 18], ["Zamin", 8], ["Bal", 7], ["Risk dərəcəsi", 10],
    ["Avtomobilin qiyməti", 14], ["İlkin ödəniş %", 10], ["İlkin ödəniş", 13], ["İlkin kredit məbləği", 15], ["Müddət (ay)", 10],
    ["İllik faiz %", 10], ["Aylıq ödəniş", 13], ["Bank komissiyası", 13], ["Təşkilatın komissiyası", 15], ["Rədd səbəbi", 30], ["Qərar verən", 14], ["Son danışığın nəticəsi", 20], ["Son dəyişiklik", 17]].map(([title, width]) => ({ title, width }));
  const r2 = x => Math.round(x * 100) / 100;
  const data = rows.map(a => {
    const o = a.offer, t = o?.price ? finalTerms(o, o.final?.downPct ?? o.downPct) : null;
    return [a.id, a.created_at, EXPORT_STATUS[a.status] || a.status, a.fin, `${a.id_series} ${a.id_number}`,
      a.birth_date ? a.birth_date.split("-").reverse().join(".") : "", "+" + a.phone, a.partner || "", a.partner_ref || "",
      (a.income_sources || []).map(s => INCOME_NAMES[s] || s).join(", "), a.voen || "", a.brand, a.model,
      a.guarantor == null ? "" : a.guarantor ? "Bəli" : "Xeyr", a.score ?? "", a.grade || "",
      t ? o.price : "", t ? t.dp : "", t ? r2(t.down) : "", t ? r2(t.credit) : "", t ? t.months : "", t ? o.rate : "", t ? r2(t.pay) : "", t ? r2(t.fee) : "", t ? r2(t.org.amount) : "",
      a.reject_public || "", a.decided_by || "", CALL_RESULTS[a.last_call] || ROBO_RESULTS[a.last_call] || "", a.updated_at];
  });
  audit(req, req.user.username, "apps.export", `${rows.length} müraciət${st ? `, status: ${st}` : ""}${q ? `, axtarış: ${q}` : ""}`);
  const day = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="arzoom-muracietler-${day}.xlsx"`, "Cache-Control": "no-store" });
  res.send(Xlsx.build("Müraciətlər", cols, data));
});

app.get("/api/admin/stats", admin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
           count(*) FILTER (WHERE status = 'review')::int AS waiting,
           count(*) FILTER (WHERE status = 'review' AND created_at < now() - interval '24 hours')::int AS overdue,
           count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status IN ('offer','reoffer','accepted','declined'))::int AS approved30,
           count(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status IN ('offer','reoffer','accepted','declined','rejected'))::int AS decided30,
           count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
           round(avg((assessment->'result'->>'score')::int))::int AS avg_score
    FROM applications WHERE ($1::text[] IS NULL OR brand = ANY($1))`, [req.user.brands]);
  res.json(rows[0]);
});

app.get("/api/admin/applications/:id", admin, brandGate, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM applications WHERE id = $1", [req.params.id]);
  if (!rows[0]) return bad(res, "Müraciət tapılmadı.", 404);
  const files = await pool.query("SELECT * FROM application_files WHERE application_id = $1 ORDER BY id", [req.params.id]);
  const events = await pool.query("SELECT * FROM application_events WHERE application_id = $1 ORDER BY at, id", [req.params.id]);
  const { bureau_xml, ...app } = rows[0];
  // ArzoomCall calls for this application from the latest analytics snapshot (no phone numbers)
  const calls = ((await loadCallStats())?.recent_calls || []).filter(c => c && c.application_id === app.id).slice(0, 50)
    .map(({ phone, ...c }) => c);
  res.json({ ...app, has_bureau_xml: !!bureau_xml, files: files.rows.map(f => ({ ...f, original_name: fixName(f.original_name) })), events: events.rows, calls });
});

// Saves the analyst's inputs; the score is always recomputed on the server.
app.put("/api/admin/applications/:id/assessment", admin, brandGate, can("apps.assess"), async (req, res) => {
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
  // Keep the bureau-only factors when an expert edits the form after an AKB report was loaded.
  const br = (await pool.query("SELECT bureau FROM applications WHERE id = $1", [req.params.id])).rows[0]?.bureau;
  if (br?.inputs) for (const k of ["overdueMonths12", "hardInquiries90", "prolongations", "historyMonths", "bureau"]) inputs[k] = br.inputs[k];
  const result = Scoring.assess(inputs);
  const assessment = { inputs, result, by: req.staff, at: new Date().toISOString() };
  const r = await pool.query("UPDATE applications SET assessment = $2, updated_at = now() WHERE id = $1 RETURNING id", [req.params.id, assessment]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, req.staff, "assessed", { score: result.score, grade: result.grade, verdict: result.verdict });
  res.json(assessment);
});

// Staff send the offer back; the page then shows it with the payment schedule.
app.post("/api/admin/applications/:id/offer", admin, brandGate, can("apps.offer"), async (req, res) => {
  const b = req.body || {};
  const offer = {
    price: num(b.price, 1000, 1e7), downPct: num(b.downPct ?? 20, 0, 90), months: num(b.months ?? 36, 6, 84),
    rate: num(b.rate ?? 17, 0, 60),
    // The organization's commission on the credit amount, and the bank's on the down payment: staff may type their own
    // bank commission, otherwise it follows the down payment the customer ends up choosing.
    commissionPct: num(b.commissionPct ?? ORG_COMMISSION, 0, 10),
    bankCommissionAuto: b.bankCommissionPct == null || b.bankCommissionAuto === true,
    bankCommissionPct: b.bankCommissionPct == null || b.bankCommissionAuto === true ? commissionFor(+b.downPct || 20) : num(b.bankCommissionPct, 0, 10),
    costs: { dyp: num(b.costs?.dyp ?? 650, 0, 1e6), kasko: num(b.costs?.kasko ?? (b.price ? Math.round((+b.price * 0.0238 + 20) * 100) / 100 : 0), 0, 1e6), gps: num(b.costs?.gps ?? Math.round(169.92 * Math.ceil((+b.months || 36) / 12) * 100) / 100, 0, 1e6) }, at: new Date().toISOString()
  };
  if (Object.values(offer.costs).some(v => v == null)) return bad(res, "Digər xərclər düzgün deyil.");
  if (offer.price == null) return bad(res, "Qiymət düzgün deyil.");
  if (Object.values(offer).some(v => v == null)) return bad(res, "Təklif şərtləri düzgün deyil.");
  const r = await pool.query(
    `UPDATE applications SET status = 'offer', offer = $2, reject_reason = NULL, reject_public = NULL, decided_by = $3, updated_at = now()
     WHERE id = $1 AND status IN ('review','info','offer','reoffer','rejected') RETURNING id, phone, brand, model`, [req.params.id, offer, req.staff]);
  if (!r.rowCount) return bad(res, "Bu müraciətə təklif göndərmək olmur.", 409);
  await logEvent(pool, req.params.id, req.staff, "offer", offer);
  sendResult(req.params.id);
  const ft = finalTerms(offer, offer.downPct), pay = ft.pay;
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id} təsdiqləndi. Təklif: ilkin ödəniş ${offer.downPct}% (${money(offer.price * offer.downPct / 100)}), aylıq ${money(pay)}, ${offer.months} ay${ft.other.total ? `, digər xərclər (DYP, KASKO, GPS, bank komissiyası) ${money(ft.other.total)}` : ""}. Kabinetdə qrafikə baxıb təsdiqləyin.${cabinet()}`);
  // The offer also goes to the sales specialists of this brand (or those without a brand), so they can call the customer.
  const { brand, model } = r.rows[0], credit = money(offer.price * (1 - offer.downPct / 100));
  const sales = await pool.query(
    "SELECT name, phone FROM staff_users WHERE active AND phone IS NOT NULL AND role = 'sales' AND (cardinality(brands) = 0 OR $1 = ANY(brands))", [brand]);
  for (const u of sales.rows)
    notify(req.params.id, u.phone, `Arzoom Avto: Müraciət № ${req.params.id} üzrə müştəriyə təklif göndərildi: ${brand} ${model}, qiymət ${money(offer.price)}, ilkin ödəniş ${offer.downPct}%, ilkin kredit məbləği ${credit}, aylıq ${money(pay)}, ${offer.months} ay${ft.org.amount ? `, təşkilatın komissiyası ${money(ft.org.amount)}` : ""}.${SITE_URL ? ` Panel: ${SITE_URL}/admin` : ""}`, u.name);
  res.json({ ok: true, offer });
});

// Before an offer the expert may ask the customer for more documents or information. The customer answers in the cabinet.
// An application that came without the partner's ref (e.g. the link lost it): staff add the ref by hand.
// The partner then gets "submitted" and, when the application is already decided, the current result too.
app.post("/api/admin/applications/:id/partner-ref", admin, brandGate, can("apps.assess"), async (req, res) => {
  const ref = partnerCode(req.body?.ref), partner = partnerCode(req.body?.partner);
  if (!ref) return bad(res, "Ref nömrəsi yalnız hərf, rəqəm, nöqtə, tire və alt xətdən ibarət ola bilər (64 simvoladək).");
  const r = await pool.query(
    "UPDATE applications SET partner_ref = $2, partner = COALESCE(partner, $3) WHERE id = $1 RETURNING id, status, partner, partner_ref",
    [req.params.id, ref, partner]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, req.staff, "partner_ref", { ref });
  audit(req, req.user.username, "apps.partner_ref", `${req.params.id}: ${ref}`);
  if (WH.url) {
    await postResult(req.params.id, 1, "submitted").catch(e => console.error(e.message));
    if (WH_EVENT[r.rows[0].status] && WH_EVENT[r.rows[0].status] !== "submitted") await postResult(req.params.id).catch(e => console.error(e.message));
  }
  res.json({ ok: true, partner: r.rows[0].partner, partner_ref: r.rows[0].partner_ref, sent: !!WH.url });
});

// Documents staff can ask for, combined by drag and drop in the panel. "custom" carries a label typed by staff.
const INFO_DOCS = {
  mygov_salary: "MyGov-dan rəsmi əmək haqqı arayışı", salary_card: "Əmək haqqı kart hesabından çıxarış (son 6 ay)",
  debit_card: "Debet kartdan çıxarış (son 12 ay)", work_ref: "İş yerindən arayış (vəzifə və maaş)",
  dsmf: "DSMF-dən sosial sığorta arayışı", pension: "Pensiya ödənişi haqqında arayış", voen_extract: "VÖEN çıxarışı",
  biz_bank: "Biznes hesabından çıxarış (son 6 ay)", rent: "İcarə müqaviləsi", property: "Əmlak sənədi (çıxarış)",
  guarantor_id: "Zaminin şəxsiyyət vəsiqəsi", guarantor_income: "Zaminin gəlir sənədi"
};
function infoDocs(list) {
  if (!Array.isArray(list) || list.length > 8) return null;
  const out = [];
  for (const d of list) {
    const key = String(d?.key || "");
    if (key === "custom") {
      const label = String(d?.label || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (label.length < 3) return null;
      out.push({ key, label });
    } else if (Object.hasOwn(INFO_DOCS, key)) out.push({ key, label: INFO_DOCS[key] });
    else return null;
  }
  return out;
}
app.get("/api/admin/info-docs", admin, (_req, res) => res.json(INFO_DOCS));

app.post("/api/admin/applications/:id/request-info", admin, brandGate, can("apps.assess"), async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 300);
  const docs = infoDocs(req.body?.docs ?? []);
  if (!docs) return bad(res, "Sənəd siyahısı düzgün deyil (ən çox 8 sənəd).");
  if (text.length < 5 && !docs.length) return bad(res, "Müştəridən nə tələb olunduğunu yaz və ya sənəd seç.");
  const request = { text, docs, at: new Date().toISOString(), by: req.staff, byUser: req.user.username };
  const r = await pool.query(
    `UPDATE applications SET status = 'info', info_request = $2, updated_at = now()
     WHERE id = $1 AND status IN ('review','info') RETURNING id, phone`, [req.params.id, request]);
  if (!r.rowCount) return bad(res, "Bu müraciət üçün məlumat istəmək olmur.", 409);
  const need = [docs.map(d => d.label).join(", "), text].filter(Boolean).join(". ");
  await logEvent(pool, req.params.id, req.staff, "info_request", { text: need });
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id} üzrə əlavə məlumat lazımdır: ${need}. Kabinetdə sənədləri yükləyin.${cabinet()}`);
  res.json({ ok: true, request });
});

app.post("/api/admin/applications/:id/reject", admin, brandGate, can("apps.reject"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const code = String(req.body?.code || "");
  if (!REJECT_REASONS[code]) return bad(res, "Müştəriyə göstəriləcək səbəbi seç.");
  if (!reason) return bad(res, "İmtina səbəbini yaz.");
  const pub = REJECT_REASONS[code];
  const r = await pool.query(
    `UPDATE applications SET status = 'rejected', reject_reason = $2, reject_public = $4, decided_by = $3, updated_at = now()
     WHERE id = $1 AND status IN ('review','info','offer','reoffer') RETURNING id, phone`, [req.params.id, reason, req.staff, pub]);
  if (!r.rowCount) return bad(res, "Bu müraciəti rədd etmək olmur.", 409);
  await logEvent(pool, req.params.id, req.staff, "rejected", { reason, code });
  sendResult(req.params.id);
  notify(req.params.id, r.rows[0].phone, `Arzoom Avto: Müraciət № ${req.params.id} təsdiqlənmədi. Səbəb: ${pub} Sualınız varsa, *5665 nömrəsinə zəng edin.`);
  res.json({ ok: true });
});

// Result of a talk with the customer, picked from a fixed list; the note text is optional with it.
const LAST_CALL = `(SELECT details->>'outcome' FROM application_events e WHERE e.application_id = applications.id AND e.kind = 'note' AND details ? 'outcome' ORDER BY e.at DESC LIMIT 1)`;
app.post("/api/admin/applications/:id/notes", admin, brandGate, can("apps.notes"), async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  const outcome = req.body?.outcome ? String(req.body.outcome) : null;
  if (outcome && !Object.hasOwn(CALL_RESULTS, outcome)) return bad(res, "Danışığın nəticəsi düzgün deyil.");
  if (!text && !outcome) return bad(res, "Qeyd boşdur.");
  const channel = outcome ? (req.body?.channel === "meeting" ? "meeting" : "phone") : null;
  const r = await pool.query("SELECT 1 FROM applications WHERE id = $1", [req.params.id]);
  if (!r.rowCount) return bad(res, "Müraciət tapılmadı.", 404);
  await logEvent(pool, req.params.id, req.staff, "note", outcome ? { text, outcome, channel } : { text });
  res.json({ ok: true });
});

// Only admins delete. Files on disk go too; the deletion itself stays in deletion_log.
app.delete("/api/admin/applications/:id", admin, brandGate, can("apps.delete"), async (req, res) => {
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
  audit(req, req.user.username, "app.delete", req.params.id);
  res.json({ ok: true });
});

/* ---------- AKB credit report ---------- */
const xmlBody = express.text({ type: ["text/xml", "application/xml", "text/plain"], limit: "2mb" });
const MANUAL_KEYS = ["incomeMonthly", "tenureMonths", "docsOk", "price", "downPct", "months", "rate", "akbNote"];
// Every incoming report is parsed, merged with what the expert already entered (income, car, terms)
// and scored at once; the result is stored as the current assessment.
async function applyBureau(id, xml, actor) {
  const { rows } = await pool.query("SELECT fin, assessment, offer FROM applications WHERE id = $1", [id]);
  if (!rows[0]) return null;
  const report = Akb.analyze(Akb.parse(xml), { fin: rows[0].fin });
  const prev = rows[0].assessment?.inputs || {}, o = rows[0].offer || {};
  const inputs = { downPct: o.downPct ?? 20, months: o.months ?? 36, rate: o.rate ?? 17, price: o.price ?? 0 };
  for (const k of MANUAL_KEYS) if (prev[k] !== undefined) inputs[k] = prev[k];
  Object.assign(inputs, report.inputs);
  const result = Scoring.assess(inputs);
  const assessment = { inputs, result, by: actor, at: new Date().toISOString(), auto: true };
  await pool.query("UPDATE applications SET bureau = $2, bureau_xml = $3, bureau_at = now(), assessment = $4, updated_at = now() WHERE id = $1",
    [id, report, String(xml).slice(0, 2e6), assessment]);
  await logEvent(pool, id, actor, "bureau", {
    reportId: report.reportId, score: result.score, grade: result.grade, verdict: result.verdict,
    debtMonthly: report.summary.debtMonthly, active: report.summary.activeCount, flags: report.flags.length
  });
  return { report, assessment };
}
const xmlFrom = req => typeof req.body === "string" ? req.body : String(req.body?.xml || "");

app.post("/api/admin/applications/:id/bureau", admin, brandGate, can("apps.assess"), xmlBody, async (req, res) => {
  let out;
  try { out = await applyBureau(req.params.id, xmlFrom(req), `${req.staff} · AKB`); }
  catch (e) { return bad(res, e.message); }
  if (!out) return bad(res, "Müraciət tapılmadı.", 404);
  res.json(out);
});

// Machine entry point for AKB/ASAN integration: the report arrives as XML and is matched to the
// customer's open application by FİN. Enabled only when AKB_API_KEY is set.
app.post("/api/integrations/akb", xmlBody, async (req, res) => {
  const key = process.env.AKB_API_KEY || "", got = String(req.get("x-api-key") || "");
  if (key.length < 20) return bad(res, "İnteqrasiya qoşulmayıb.", 404);
  if (got.length !== key.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key))) return bad(res, "İcazə yoxdur.", 401);
  let fin;
  try { fin = String(Akb.parse(xmlFrom(req)).borrower?.fin || "").trim().toUpperCase(); } catch (e) { return bad(res, e.message); }
  const { rows } = await pool.query(
    "SELECT id FROM applications WHERE upper(fin) = $1 AND status IN ('review','info','offer','reoffer') ORDER BY created_at DESC LIMIT 1", [fin]);
  if (!rows[0]) return bad(res, "Bu FİN üzrə açıq müraciət yoxdur.", 404);
  const out = await applyBureau(rows[0].id, xmlFrom(req), "AKB inteqrasiyası");
  res.json({ applicationId: rows[0].id, score: out.assessment.result.score, grade: out.assessment.result.grade,
             verdict: out.assessment.result.verdict, flags: out.report.flags });
});

/* ---------- analytics ---------- */
app.get("/api/admin/analytics", admin, can("analytics.view"), async (req, res) => {
  const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
  const since = `now() - make_interval(days => ${days})`;
  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
  const [daily, status, grades, brands, income, timing, money, staff, bureau] = await Promise.all([
    q(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM applications a WHERE a.created_at::date = d) AS received,
              (SELECT count(*)::int FROM application_events e WHERE e.kind IN ('offer','rejected') AND e.at::date = d) AS decided,
              (SELECT count(*)::int FROM application_events e WHERE e.kind = 'accepted' AND e.at::date = d) AS accepted
       FROM generate_series((${since})::date, now()::date, interval '1 day') d ORDER BY d`),
    q(`SELECT status, count(*)::int AS n FROM applications WHERE created_at >= ${since} GROUP BY status`),
    q(`SELECT assessment->'result'->>'grade' AS grade, count(*)::int AS n FROM applications
       WHERE created_at >= ${since} AND assessment IS NOT NULL GROUP BY 1 ORDER BY 1`),
    q(`SELECT brand, count(*)::int AS n FROM applications WHERE created_at >= ${since} GROUP BY brand ORDER BY n DESC LIMIT 6`),
    q(`SELECT s AS source, count(*)::int AS n FROM applications, unnest(income_sources) s WHERE created_at >= ${since} GROUP BY s ORDER BY n DESC`),
    q(`SELECT round(avg(extract(epoch FROM (e.first - a.created_at)) / 3600)::numeric, 1)::float AS avg_hours,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (e.first - a.created_at)) / 3600))::numeric, 1)::float AS median_hours
       FROM applications a JOIN (SELECT application_id, min(at) AS first FROM application_events WHERE kind IN ('offer','rejected') GROUP BY 1) e
         ON e.application_id = a.id WHERE a.created_at >= ${since}`),
    q(`SELECT count(*) FILTER (WHERE status = 'accepted')::int AS accepted_n,
              coalesce(sum((offer->>'price')::numeric * (1 - coalesce((offer->'final'->>'downPct')::numeric, (offer->>'downPct')::numeric) / 100))
                FILTER (WHERE status = 'accepted'), 0)::float AS financed,
              coalesce(avg((offer->>'price')::numeric) FILTER (WHERE offer IS NOT NULL), 0)::float AS avg_price,
              coalesce(avg((offer->'final'->>'downPct')::numeric - (offer->>'downPct')::numeric) FILTER (WHERE offer ? 'final'), 0)::float AS avg_dp_raise,
              coalesce(avg((assessment->'result'->>'score')::numeric), 0)::float AS avg_score
       FROM applications WHERE created_at >= ${since}`),
    q(`SELECT actor, count(*) FILTER (WHERE kind = 'offer')::int AS offers, count(*) FILTER (WHERE kind = 'rejected')::int AS rejects,
              count(*) FILTER (WHERE kind = 'assessed')::int AS assessed
       FROM application_events WHERE at >= ${since} AND kind IN ('offer','rejected','assessed') GROUP BY actor ORDER BY count(*) DESC LIMIT 8`),
    q(`SELECT count(*) FILTER (WHERE bureau IS NOT NULL)::int AS with_bureau, count(*)::int AS total,
              coalesce(avg((bureau->'summary'->>'debtMonthly')::numeric), 0)::float AS avg_debt
       FROM applications WHERE created_at >= ${since}`)
  ]);
  res.json({ days, daily, status, grades, brands, income, timing: timing[0], money: money[0], staff, bureau: bureau[0] });
});

app.get("/api/admin/files/:stored", admin, can("docs.view"), async (req, res) => {
  const f = path.basename(req.params.stored);
  const { rows } = await pool.query(
    `SELECT f.application_id, f.original_name, f.mime FROM application_files f JOIN applications a ON a.id = f.application_id
     WHERE f.stored_name = $1 AND ($2::text[] IS NULL OR a.brand = ANY($2))`, [f, req.user.brands]);
  if (!rows[0]) return bad(res, "Fayl tapılmadı.", 404);
  // Only types checked on upload are shown in the browser; anything else is a download.
  const safe = /^(application\/pdf|image\/(png|jpeg|webp|heic))$/.test(rows[0].mime || "");
  res.type(safe ? rows[0].mime : "application/octet-stream");
  // A file is shown on its own, in a sandbox, never able to run script in the panel's origin.
  res.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.set("Content-Disposition", `${safe ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fixName(rows[0].original_name))}`);
  audit(req, req.user.username, "file.view", `${rows[0].application_id} · ${rows[0].original_name}`);
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
  // Security log is kept for one year.
  await pool.query("DELETE FROM audit_log WHERE at < now() - interval '1 year'");
  if (!process.env.OTP_SECRET) console.warn("OTP_SECRET .env-də yoxdur: hər yenidən başlamada göndərilmiş SMS kodları etibarsız olur.");
  await loadSmsSettings();
  await loadWebhookSettings();
  await loadRobocallSettings();
  await loadRcApi();
  await backfillRobotSales().catch(e => console.error(e.message));
  Ocr.available().then(t => { if (!t.tesseract || !t.pdftotext) console.warn("Sənəd analizi üçün tesseract və poppler-utils quraşdırılmayıb."); });
  loadStock(); setInterval(loadStock, 15 * 60 * 1000).unref();
  // First start: the "admin" account gets ADMIN_TOKEN from .env as its password; change it after signing in.
  const users = await pool.query("SELECT count(*)::int AS n FROM staff_users");
  if (!users.rows[0].n && ADMIN_TOKEN) {
    await pool.query("INSERT INTO staff_users (username, name, password_hash, role) VALUES ('admin', 'Administrator', $1, 'admin')", [hashPassword(ADMIN_TOKEN)]);
    console.log("İlk admin hesabı yaradıldı: istifadəçi adı admin, parol .env-dəki ADMIN_TOKEN.");
  }
  const srv = app.listen(PORT, () => console.log(`Arzoom lizinq: http://localhost:${PORT} (SMS provayderi: ${Sms.configured() ? "qoşulub" : "YOXDUR, müştərilər kod ala bilməz"})`));
  // Slow clients (slowloris) cannot hold connections open: headers within 20 s, the whole request (uploads included) within 2 min.
  srv.headersTimeout = 20e3; srv.requestTimeout = 120e3; srv.keepAliveTimeout = 5e3;
}
start().catch(e => { console.error(e); process.exit(1); });
