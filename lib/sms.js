// SMS göndərişi. İki yol var:
// 1) Softline (gw.soft-line.az): istifadəçi adı, açar və göndərən adı admin paneldə (İstifadəçilər → SMS provayderi)
//    bir dəfə yazılır və bazada saxlanılır. .env-dəki SOFTLINE_USER, SOFTLINE_KEY, SOFTLINE_SENDER də işləyir.
// 2) İstənilən başqa provayder: SMS_URL, {phone} və {text} yerinə nömrə və mətn yazılır.
//   GET nümunəsi:  SMS_URL=https://sms.provider.az/send?login=LOGIN&key=KEY&msisdn={phone}&text={text}
//   POST nümunəsi: SMS_METHOD=POST, SMS_BODY={"to":"{phone}","message":"{text}"},
//                  SMS_HEADERS={"Authorization":"Bearer TOKEN","Content-Type":"application/json"}
let SL_USER = process.env.SOFTLINE_USER || "";
let SL_KEY = process.env.SOFTLINE_KEY || "";
let SL_SENDER = process.env.SOFTLINE_SENDER || "Arzoomavto";
const SL_URL = process.env.SOFTLINE_URL || "https://gw.soft-line.az/sendsms";
let SOFTLINE = !!(SL_USER && SL_KEY);
// Values saved in the admin panel replace the .env ones without a restart.
function setSoftline({ user, key, sender } = {}) {
  if (user) SL_USER = user;
  if (key) SL_KEY = key;
  if (sender) SL_SENDER = sender;
  if (user || key || sender) last = null;
  SOFTLINE = !!(SL_USER && SL_KEY);
}
const softlineInfo = () => ({ user: SL_USER, sender: SL_SENDER, keySet: !!SL_KEY, last });

const URL_T = process.env.SMS_URL || "";
const METHOD = (process.env.SMS_METHOD || "GET").toUpperCase();
const BODY_T = process.env.SMS_BODY || "";
let HEADERS = {};
try { HEADERS = JSON.parse(process.env.SMS_HEADERS || "{}"); } catch { console.error("SMS_HEADERS JSON deyil, nəzərə alınmadı."); }

const fill = (t, vars, enc) => t.replace(/\{(phone|text)\}/g, (_, k) => enc(vars[k]));
const jsonEnc = s => JSON.stringify(String(s)).slice(1, -1);
const xmlEnc = s => String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

// Softline error codes (API sənədi): 100 = OK, qalanları xətadır.
const SL_ERRORS = { 0: "parametr və ya XML xətası", 10: "konfiqurasiya xətası", 20: "nömrə yanlışdır", 25: "nömrə qara siyahıdadır",
  30: "bu operatora göndəriş icazəsi yoxdur", 40: "istifadəçi adı və ya açar yanlışdır", 50: "göndərən adı təsdiqlənməyib",
  60: "balans kifayət etmir", 90: "mesaj çox uzundur", 200: "provayder serverində xəta" };

async function sendSoftline(phone, text) {
  // XML API nömrəni 9 rəqəmlə gözləyir (50XXXXXXX); tətbiq 994XXXXXXXXX saxlayır.
  const to = String(phone).replace(/\D/g, "").replace(/^994/, "");
  const xml = `<?xml version="1.0" encoding="utf-8"?><SMS-InsRequest><CLIENT user="${xmlEnc(SL_USER)}" pwd="${xmlEnc(SL_KEY)}" from="${xmlEnc(SL_SENDER)}"/><INSERT to="${xmlEnc(to)}" text="${xmlEnc(text)}"/></SMS-InsRequest>`;
  let r;
  try { r = await fetch(SL_URL, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: xml, signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw new Error(`Softline serverinə qoşulmaq olmadı (${e.cause?.code || e.name}). Serverin IP ünvanı Softline-da icazəli olmalıdır.`); }
  const body = await r.text();
  const code = Number((body.match(/\bres="(\d+)"/) || [])[1]);
  if (!r.ok || code !== 100) {
    const why = SL_ERRORS[code] || (body.match(/\brestxt="([^"]*)"/) || [])[1] || body.slice(0, 200);
    throw new Error(`Softline SMS xətası${Number.isNaN(code) ? ` (HTTP ${r.status})` : ` ${code}`}: ${why}`);
  }
  return { sent: true, response: body.slice(0, 200) };
}

// The last provider answer is kept so the admin panel can show why a message did not go out.
let last = null;
async function sendSms(phone, text) {
  try { const r = await send(phone, text); last = { ok: true, at: new Date().toISOString() }; return r; }
  catch (e) { last = { ok: false, at: new Date().toISOString(), error: e.message }; throw e; }
}
async function send(phone, text) {
  if (SOFTLINE) return sendSoftline(phone, text);
  if (!URL_T) throw new Error("SMS provayderi qoşulmayıb");
  const vars = { phone, text };
  const opts = { method: METHOD, headers: HEADERS, signal: AbortSignal.timeout(10000) };
  if (METHOD !== "GET" && BODY_T) {
    const b = BODY_T.trim();
    opts.body = fill(BODY_T, vars, b.startsWith("{") ? jsonEnc : b.startsWith("<") ? xmlEnc : encodeURIComponent);
  }
  const r = await fetch(fill(URL_T, vars, encodeURIComponent), opts);
  const body = await r.text();
  if (!r.ok) throw new Error(`SMS provayderi ${r.status}: ${body.slice(0, 200)}`);
  // Some gateways answer 200 with an error code in the body (e.g. Softline HTTP API: errno=40&errtext=...).
  const errno = (body.match(/\berrno=(\d+)/) || [])[1];
  if (errno && errno !== "100") throw new Error(`SMS provayderi xətası ${errno}: ${(body.match(/errtext=([^&]*)/) || [])[1] || body.slice(0, 200)}`);
  return { sent: true, response: body.slice(0, 200) };
}

const configured = () => SOFTLINE || !!URL_T;
const provider = () => SOFTLINE ? "softline" : URL_T ? "url" : "none";
module.exports = { sendSms, configured, provider, setSoftline, softlineInfo };
