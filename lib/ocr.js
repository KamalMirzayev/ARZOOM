// Income document analysis on the server itself: nothing leaves the machine.
// Text comes from the PDF's own text layer (pdftotext) or from Tesseract OCR (scans and photos, Azerbaijani + Russian + English).
// Rules then pull out what a credit expert checks first: whose document, FİN, issuer, dates, monthly amounts, warning signs.
// It only reads and points; the expert decides.
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Statement = require("./statement");

const LANGS = "aze+rus+eng";
const run = (cmd, args, timeout = 90e3) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

let tools = null;
async function available() {
  if (tools) return tools;
  const has = async (cmd, arg) => { try { await run(cmd, [arg], 10e3); return true; } catch { return false; } };
  tools = { tesseract: await has("tesseract", "--version"), pdftotext: await has("pdftotext", "-v"), pdftoppm: await has("pdftoppm", "-v") };
  return tools;
}

// Tesseract TSV: words with confidence, regrouped into lines.
async function ocrImage(file) {
  const tsv = await run("tesseract", [file, "stdout", "-l", LANGS, "--psm", "4", "tsv"]);
  const lines = new Map(), confs = [];
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const word = c.slice(11).join("\t").trim(), conf = Number(c[10]);
    if (!word) continue;
    if (conf >= 0) confs.push(conf);
    const key = `${c[1]}.${c[2]}.${c[3]}.${c[4]}`;
    lines.set(key, (lines.get(key) ? lines.get(key) + " " : "") + word);
  }
  return { text: [...lines.values()].join("\n"), conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0 };
}

const IMAGE = /^image\/(jpeg|png|webp|gif|tiff|bmp)$/;
async function extract(file, mime, forceOcr = false) {
  const t = await available();
  if (mime === "application/pdf") {
    if (!t.pdftotext) throw fail("Serverdə PDF oxuyucu (poppler) quraşdırılmayıb.", 503);
    const text = forceOcr ? "" : await run("pdftotext", ["-layout", "-l", "80", file, "-"]).catch(() => "");
    if (text.replace(/\s/g, "").length >= 40) return { text, conf: 100, method: "pdf" };
    // A scanned PDF has no text layer: render the first pages and run OCR on them.
    if (!t.tesseract || !t.pdftoppm) throw fail("Serverdə OCR (tesseract) quraşdırılmayıb.", 503);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arzoom-ocr-"));
    try {
      await run("pdftoppm", ["-r", "250", "-png", "-f", "1", "-l", "3", file, path.join(dir, "p")]);
      const pages = (await fs.readdir(dir)).filter(f => f.endsWith(".png")).sort();
      if (!pages.length) throw fail("PDF səhifələri oxunmadı.");
      const parts = [];
      for (const p of pages) parts.push(await ocrImage(path.join(dir, p)));
      return { text: parts.map(p => p.text).join("\n"), conf: parts.reduce((a, p) => a + p.conf, 0) / parts.length, method: "ocr" };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  if (IMAGE.test(mime || "")) {
    if (!t.tesseract) throw fail("Serverdə OCR (tesseract) quraşdırılmayıb.", 503);
    return { ...(await ocrImage(file)), method: "ocr" };
  }
  throw fail("Bu format oxunmur (yalnız PDF, JPG, PNG, WEBP).");
}

/* ---------- rules ---------- */
const CYR = { а: "a", б: "b", в: "v", г: "q", ғ: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "c", ш: "s", щ: "s", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ә: "e", ө: "o", ү: "u", ҹ: "c", һ: "h", ј: "y" };
// Latin, lowercase, no diacritics: "Məmmədov Елвин" -> "memmedov elvin"
const plain = s => String(s || "").toLowerCase().replace(/i̇/g, "i")
  .replace(/[а-яёәөүҹһғј]/g, ch => CYR[ch] ?? ch)
  .replace(/[əä]/g, "e").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ğ/g, "g").replace(/ş/g, "s").replace(/ç/g, "c")
  .normalize("NFD").replace(/[̀-ͯ]/g, "");

const MONTHS = [
  ["yanvar", "январ", "january", "jan"], ["fevral", "феврал", "february", "feb"], ["mart", "март", "march", "mar"], ["aprel", "апрел", "april", "apr"],
  ["may", "мая", "май", "may"], ["iyun", "июн", "june", "jun"], ["iyul", "июл", "july", "jul"], ["avqust", "август", "august", "aug"],
  ["sentyabr", "сентябр", "september", "sep"], ["oktyabr", "октябр", "october", "oct"], ["noyabr", "ноябр", "november", "nov"], ["dekabr", "декабр", "december", "dec"]
].map(names => names.map(plain));
const monthOf = line => { const w = plain(line); for (let i = 0; i < 12; i++) if (MONTHS[i].some(n => new RegExp(`(^|[^a-z])${n}`).test(w))) return i + 1; return 0; };

const KEY = /(emek haqq|maas|gelir|zarplat|zarabotn|oklad|salary|pensiya|pensi|teqaud|muavinet|medaxil|daxilolma|mukafat|premiya|bonus)/;
const NET = /(xalis|elde edil|odenil|net|chist|k vydache|na ruki)/, GROSS = /(hesablanmis|umumi|gross|nachislen|brutto)/;
const MONEY = /(azn|manat|₼|man\.)/i;
const DATE = /\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b|\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const AMOUNT = /\b\d{1,3}(?:[  ]\d{3})+(?:[.,]\d{1,2})?\b|\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b|\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})?\b/g;

function parseAmount(tok) {
  let s = tok.replace(/[  ]/g, "");
  const m = s.match(/[.,](\d{1,2})$/);
  const dec = m ? m[1] : "";
  if (m) s = s.slice(0, -m[0].length);
  return Number(s.replace(/[.,]/g, "") + (dec ? "." + dec : ""));
}
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const round2 = n => Math.round(n * 100) / 100;

const TYPES = [
  ["card_statement", "Kart hesabından çıxarış", /(kart).*(cixaris|vypisk|statement)|(cixaris|vypisk|statement).*(kart)/],
  ["bank_statement", "Bank hesabından çıxarış", /(hesab(dan)? cixaris|cixaris|vypisk|account statement|bank statement)/],
  ["employment_contract", "Əmək müqaviləsi", /(emek muqavile|trudov.{0,5} dogovor|employment contract)/],
  ["social_insurance", "Sosial sığorta (DSMF) çıxarışı", /(dsmf|sosial sigorta|socialn.{0,4} straxov)/],
  ["pension_certificate", "Pensiya arayışı", /(pensiya|teqaud|pensi)/],
  ["tax_declaration", "Vergi bəyannaməsi", /(beyanname|deklaraci|tax return)/],
  ["rent_contract", "Kirayə (icarə) müqaviləsi", /(kiraye|icare|arend)/],
  ["salary_certificate", "Əmək haqqı arayışı", /(arayis|spravk).*(emek haqq|maas|zarplat|zarabotn)|(emek haqq|maas|zarplat|zarabotn).*(arayis|spravk)/s],
  ["business_document", "Sahibkarlıq sənədi", /(voen|ferdi sahibkar|vergi odeyicisi)/]
];

// OCR sometimes reads Latin capitals as look-alike Cyrillic ones ("ВЕТ" for "BET"); in a mostly Latin text they are put back.
const LOOK = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y" };
function fixLookalikes(text) {
  const lat = (text.match(/[A-Za-zƏəÜüÖöĞğİıŞşÇç]/g) || []).length, cyr = (text.match(/[А-Яа-яЁё]/g) || []).length;
  return lat > cyr * 4 ? text.replace(/[АВЕКМНОРСТХУаеорсху]/g, ch => LOOK[ch]) : text;
}
// Some statements (Unibank, Birbank) print the date on its own line, the description and amounts on the next, the time after:
// such a date line is joined with the following line so the transaction keeps its date.
const DATE_ONLY = /^(\d{1,2}[./-]\d{1,2}[./-]20\d{2}|20\d{2}-\d{2}-\d{2})(\s+\d{1,2}:\d{2}(:\d{2})?)?$/;
const TIME_ONLY = /^\d{1,2}:\d{2}(:\d{2})?$/;
function joinDateLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1];
    if (DATE_ONLY.test(l) && next && !DATE_ONLY.test(next) && !TIME_ONLY.test(next) && !new RegExp(DATE.source).test(next) && /\d[.,]\d{2}\b/.test(next)) {
      out.push(l + " " + next); i++;
    } else if (!TIME_ONLY.test(l)) out.push(l);
  }
  return out;
}
const SIGNED = new RegExp(`([+\\-−]\\s?)?(${AMOUNT.source})`, "g");

function analyzeText(text, conf, method, applicant) {
  text = fixLookalikes(text);
  const lines = joinDateLines(text.split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean));
  const all = plain(text);
  const now = new Date(), today = now.toISOString().slice(0, 10);
  const out = { method, ocr_confidence: Math.round(conf), red_flags: [] };

  // document type
  const t = all.replace(/\s+/g, " ");
  const type = t.replace(/\W/g, "").length < 30 ? ["unreadable", "Oxunmadı"] : TYPES.find(([, , re]) => re.test(t)) || ["other", "Digər sənəd"];
  [out.doc_type, out.doc_type_label] = type;

  // FİN: 7 letters/digits with both; O and 0, I and 1 compared as the same
  const fold = s => s.toUpperCase().replace(/O/g, "0").replace(/I/g, "1").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2").replace(/G/g, "6");
  const finRe = /\b(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{7}\b/g;
  const fins = [...new Set((text.toUpperCase().replace(/İ/g, "I").match(finRe) || []))];
  const want = applicant.fin ? fold(applicant.fin) : "";
  const finHit = want && fins.find(f => fold(f) === want);
  out.holder_fin = finHit || (fins.length === 1 ? fins[0] : null);
  out.fin_match = !want ? "unknown" : finHit ? "match" : fins.length ? "mismatch" : "unknown";
  if (out.fin_match === "mismatch") out.red_flags.push(`Sənəddəki FİN (${fins.slice(0, 3).join(", ")}) müştərinin FİN-i ilə uyğun deyil`);

  // name from the credit bureau report, checked word by word (patronymic endings ignored)
  const parts = plain(applicant.name).split(/[^a-z]+/).filter(w => w.length >= 3 && !/^(oglu|qizi|ogly|kyzy)$/.test(w));
  const found = parts.filter(w => all.includes(w));
  out.holder_name = found.length ? applicant.name : null;
  out.name_match = !parts.length ? "unknown" : found.length >= Math.min(2, parts.length) ? "match" : found.length ? "partial" : t.length > 200 ? "mismatch" : "unknown";
  if (out.name_match === "mismatch") out.red_flags.push("Müştərinin adı sənəddə tapılmadı");
  if (out.name_match === "partial") out.red_flags.push("Müştərinin adı sənəddə qismən tapıldı, gözlə yoxlayın");

  // issuer, position, VÖEN
  out.issuer = (lines.find(l => /\b(MMC|ASC|QSC|ACSC|ООО|ОАО|ЗАО|LLC|BANK|БАНК)\b|NAZİRLİY|DSMF|FOND/i.test(l)) || "").slice(0, 90) || null;
  const pos = text.match(/([\p{L}-]+(?: [\p{L}-]+)?) vəzifəsində/iu);
  out.position = pos ? pos[1] : null;
  const voen = text.match(/V[ÖO]EN[:\s№]*(\d{10})/i);
  out.voen = voen ? voen[1] : null;

  // dates and lines with income amounts
  const dates = [], perMonth = new Map(), loose = [], txLines = [];
  const BIRTH = /(dogum|tevellud|anadan olub|birth|рожд)/;
  let net = 0, gross = 0;
  const years = (text.match(/\b20\d{2}\b/g) || []).map(Number).filter(y => y >= 2015 && y <= now.getFullYear() + 1);
  const docYear = Number(median(years)) || now.getFullYear();
  for (const raw of lines) {
    const p = plain(raw);
    const lineDates = [];
    const rest = raw.replace(DATE, (m, d, mo, y, y2, mo2, d2) => {
      const v = y ? iso(y, mo, d) : iso(y2, mo2, d2);
      // a birth date is not a document or period date (an employment contract lists the employee's)
      if (!isNaN(Date.parse(v)) && !BIRTH.test(p)) { lineDates.push(v); dates.push(v); }
      return " ";
    });
    // every dated line with an amount is a possible statement transaction
    if (lineDates.length) {
      const amounts = [];
      const desc = rest.replace(/\b\d{4,6}\*{2,}[\d *]*/g, " kartdan karta ").replace(/\*{2,}[\d *]*/g, " ").replace(SIGNED, (m, sign, num) => {
        const v = parseAmount(num);
        if (v > 0 && v <= 1e6 && !/^\d{5,}$/.test(num)) amounts.push({ value: v, sign: sign ? (sign.trim() === "+" ? "+" : "-") : "", dec: /[.,]\d{2}$/.test(num) });
        return " ";
      }).replace(/\b(AZN|USD|EUR|manat)\b/gi, " ").replace(/(^|\s)[-–—](?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
      if (amounts.length) txLines.push({ dates: lineDates, amounts, desc, descPlain: " " + plain(desc) + " " });
    }
    const mon = monthOf(raw);
    const isIncome = KEY.test(p) || mon || (MONEY.test(raw) && lineDates.length);
    if (!isIncome) continue;
    if (NET.test(p)) net++; if (GROSS.test(p)) gross++;
    const toks = (rest.replace(/V[ÖO]EN[:\s№]*\d+/gi, " ").replace(/\b20\d{2}\b(?![.,]\d)/g, " ").match(AMOUNT) || [])
      .map(parseAmount).filter(n => n >= 30 && n <= 200000);
    if (!toks.length) continue;
    const amount = toks[0];
    let month = null;
    if (mon) { const y = (raw.match(/\b(20\d{2})\b/) || [])[1] || docYear; month = `${y}-${String(mon).padStart(2, "0")}`; }
    else if (lineDates.length) month = lineDates[0].slice(0, 7);
    if (month) perMonth.set(month, round2((perMonth.get(month) || 0) + amount)); else if (KEY.test(p)) loose.push(amount);
  }
  out.monthly_items = [...perMonth].sort(([a], [b]) => a.localeCompare(b)).slice(-24).map(([month, amount]) => ({ month, amount, note: null }));
  // statements: transactions by income and expense category; the monthly income is the salary (or steady income) per month
  const tx = Statement.parse(txLines);
  if (tx.length >= 5 || (/statement/.test(out.doc_type) && tx.length)) {
    if (!/statement/.test(out.doc_type)) [out.doc_type, out.doc_type_label] = ["bank_statement", "Bank hesabından çıxarış"];
    const s = Statement.summarize(tx);
    out.statement = { months: s.months, income: s.income, expense: s.expense, net_monthly: s.net_monthly, transactions: tx.slice(0, 300) };
    out.monthly_items = s.perMonth;
    out.red_flags.push(...Statement.flags(s));
  }
  // the statement's own totals ("Mədaxil əməliyyatlarının cəmi"), to check that every page was read
  const tot = re => { const m = all.match(re); return m ? parseAmount(m[1]) : null; };
  const declIn = tot(/medaxil emeliyyatlarinin cemi:?\s*([\d\s.,]+\d)/), declOut = tot(/xerc emeliyyatlarinin cemi:?\s*([\d\s.,]+\d)/);
  if (out.statement && declIn != null) {
    out.statement.declared = { income: declIn, expense: declOut };
    if (Math.abs(out.statement.income.total - declIn) > Math.max(1, declIn * 0.05))
      out.red_flags.push(`Çıxarışda mədaxil cəmi ${declIn} AZN yazılıb, oxunan əməliyyatlarda ${out.statement.income.total} AZN tapıldı (bəzi səhifələr oxunmayıb ola bilər)`);
  }
  // income for the assessment: median of the last 12 months; in a statement a month without income counts as 0
  // months of the statement period from its header ("Dövr: 09-11-2025 - 09-11-2026"), so months without any transaction count too
  const per = all.match(/(?:dovr|period|dovru)[^\d\n]{0,20}(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\s*[-–]\s*(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/);
  if (out.statement && per) {
    const a = Number(per[3]) * 12 + Number(per[2]) - 1, b = Math.min(Number(per[6]) * 12 + Number(per[5]) - 1, now.getFullYear() * 12 + now.getMonth());
    if (b >= a && b - a < 60) out.statement.period_months = Array.from({ length: b - a + 1 }, (_, i) => `${Math.floor((a + i) / 12)}-${String((a + i) % 12 + 1).padStart(2, "0")}`);
  }
  const byMonth = out.statement
    ? (out.statement.period_months || out.statement.months).map(m => ({ month: m, amount: (out.monthly_items.find(i => i.month === m) || {}).amount || 0 }))
    : out.monthly_items;
  const last12 = byMonth.slice(-12);
  out.income_median_12m = last12.length ? round2(median(last12.map(i => i.amount))) : null;
  out.income_months = last12.length;
  // work or activity tenure in months: a start date in the text ("01.03.2020-ci il tarixdən"), else the months the income is seen
  const start = text.match(/(\d{1,2})[./-](\d{1,2})[./-](20\d{2}|19\d{2})[-\s]*(?:ci|cı|cu|cü)?\s*(?:il)?\s*(?:tarix(?:in)?d[əe]n|d[əa]n)\b[^\n]{0,40}(işl|çalış|vəzif|işə)/iu)
    || text.match(/(20\d{2}|19\d{2})[-\s]*(?:ci|cı|cu|cü)?\s*(?:il)?\s*(?:d[əa]n|ild[əe]n)\s[^\n]{0,40}(işl|çalış|vəzif)/iu);
  const nowM = now.getFullYear() * 12 + now.getMonth();
  if (start) {
    const y = Number(start[3] && /^\d{4}$/.test(start[3]) ? start[3] : start[1]), mo = start[3] && /^\d{4}$/.test(start[3]) ? Number(start[2]) : 1;
    const t = nowM - (y * 12 + mo - 1);
    if (t >= 0 && t < 600) { out.tenure_months = t; out.tenure_source = "document"; }
  }
  if (out.tenure_months == null) {
    const seen = byMonth.filter(i => i.amount > 0).map(i => i.month).sort();
    if (seen.length) {
      const [y0, m0] = seen[0].split("-").map(Number), [y1, m1] = seen[seen.length - 1].split("-").map(Number);
      out.tenure_months = (y1 * 12 + m1) - (y0 * 12 + m0) + 1; out.tenure_source = "income_months";
    }
  }
  const vals = out.monthly_items.map(i => i.amount);
  out.avg_monthly_net = vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : loose.length ? median(loose) : null;
  out.amount_basis = /(xalis|chist|\bnet\b|na ruki|k vydache)/.test(all) ? "net" : net > gross ? "net" : gross > net ? "gross" : "unknown";
  out.currency = /\b(usd|\$)/i.test(text) && !MONEY.test(text) ? "USD" : "AZN";

  const past = dates.filter(d => d <= today).sort();
  out.issue_date = past.length ? past[past.length - 1] : null;
  out.period_from = out.statement ? out.statement.months[0] : vals.length ? out.monthly_items[0].month : past[0] || null;
  out.period_to = out.statement ? out.statement.months[out.statement.months.length - 1] : vals.length ? out.monthly_items[out.monthly_items.length - 1].month : null;
  out.stamp_signature = "unchecked";

  // warning signs
  if (out.issue_date) {
    const age = Math.round((now - new Date(out.issue_date)) / 864e5);
    if (age > 30) out.red_flags.push(`Sənədin tarixi ${out.issue_date}, ${age} gün əvvəl verilib (30 gündən köhnə)`);
  }
  if (dates.some(d => d > today)) out.red_flags.push("Sənəddə gələcək tarix var");
  if (out.avg_monthly_net == null && out.doc_type !== "unreadable") out.red_flags.push("Gəlir məbləği tapılmadı, sənədə gözlə baxın");
  if (!out.statement && out.issue_date && out.doc_type !== "salary_certificate") { /* age rule below applies to all */ }
  if (vals.length >= 2 && Math.max(...vals) > 1.4 * Math.min(...vals)) out.red_flags.push("Aylar arasında məbləğ çox dəyişir (birdəfəlik ödəniş ola bilər), daimi gəliri ayrıca qiymətləndirin");
  if (applicant.declaredIncome && out.avg_monthly_net && out.avg_monthly_net < applicant.declaredIncome * 0.85)
    out.red_flags.push(`Sənəddəki orta gəlir (${out.avg_monthly_net}) qiymətləndirmədə yazılan gəlirdən (${applicant.declaredIncome}) aşağıdır`);
  if (method === "ocr" && conf < 60) out.red_flags.push(`Şəkil zəif oxundu (OCR dəqiqliyi ${Math.round(conf)}%), daha aydın foto istəyin`);
  if (out.amount_basis === "gross") out.red_flags.push("Məbləğ vergidən əvvəlki (hesablanmış) ola bilər, xalis gəliri yoxlayın");

  const good = (method === "pdf" || conf >= 80) && out.avg_monthly_net != null && out.fin_match !== "mismatch" && out.name_match !== "mismatch";
  out.confidence = out.doc_type === "unreadable" || (method === "ocr" && conf < 60) || out.avg_monthly_net == null ? "low" : good ? "high" : "medium";
  const fmt = n => Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/ /g, " ");
  out.summary = out.doc_type === "unreadable" ? "Sənəddən mətn oxunmadı. Daha aydın foto və ya PDF istəyin." :
    `${out.doc_type_label}${out.issuer ? `, ${out.issuer}` : ""}.` +
    (out.statement ? ` ${out.statement.months.length} ay, ${out.statement.transactions.length} əməliyyat: ayda orta mədaxil ${fmt(out.statement.income.monthly)}, xərc ${fmt(out.statement.expense.monthly)} AZN.` : "") +
    (out.avg_monthly_net != null ? ` ${vals.length ? `${vals.length} ay üzrə orta` : "Tapılan"} aylıq ${out.statement ? (out.monthly_items[0]?.note || "gəlir") : "məbləğ"} ${fmt(out.avg_monthly_net)} ${out.currency}.` : " Gəlir məbləği avtomatik tapılmadı.") +
    ` ${method === "pdf" ? "PDF-in mətni oxundu." : `Şəkil OCR ilə oxundu (dəqiqlik ${Math.round(conf)}%).`}`;
  out.text = text.slice(0, 6000);
  return out;
}

const BASIS = { net: "xalis", gross: "hesablanmış (vergidən əvvəl)", unknown: "növü bilinmir" };
async function analyze({ filePath, mime, applicant }) {
  let r;
  try { r = await extract(filePath, mime); }
  catch (e) { if (e.status) throw e; throw fail(e.killed ? "Sənəd çox uzun oxunur, daha kiçik fayl istəyin." : "Sənəd oxunmadı: fayl zədəli ola bilər.", 422); }
  let out = analyzeText(r.text, r.conf, r.method, applicant);
  // Some PDFs carry a broken text layer (custom fonts give garbage): when nothing was found, read the rendered pages instead.
  if (r.method === "pdf" && out.avg_monthly_net == null && !out.statement) {
    const t = await available();
    if (t.tesseract && t.pdftoppm) {
      const o = await extract(filePath, mime, true).catch(() => null);
      const alt = o && analyzeText(o.text, o.conf, o.method, applicant);
      if (alt && (alt.avg_monthly_net != null || alt.statement)) out = alt;
    }
  }
  out.amount_basis_label = BASIS[out.amount_basis];
  return out;
}

module.exports = { analyze, analyzeText, available };
