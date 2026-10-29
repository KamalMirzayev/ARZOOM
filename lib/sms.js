// SMS göndərişi. İki yol var, ikisi də .env-dən qoşulur:
// 1) Softline (gw.soft-line.az): SOFTLINE_USER, SOFTLINE_KEY, SOFTLINE_SENDER. XML API HTTPS ilə işləyir.
// 2) İstənilən başqa provayder: SMS_URL, {phone} və {text} yerinə nömrə və mətn yazılır.
//   GET nümunəsi:  SMS_URL=https://sms.provider.az/send?login=LOGIN&key=KEY&msisdn={phone}&text={text}
//   POST nümunəsi: SMS_METHOD=POST, SMS_BODY={"to":"{phone}","message":"{text}"},
//                  SMS_HEADERS={"Authorization":"Bearer TOKEN","Content-Type":"application/json"}
const SL_USER = process.env.SOFTLINE_USER || "";
const SL_KEY = process.env.SOFTLINE_KEY || "";
const SL_SENDER = process.env.SOFTLINE_SENDER || "Arzoomavto";
const SL_URL = process.env.SOFTLINE_URL || "https://gw.soft-line.az/sendsms";
const SOFTLINE = !!(SL_USER && SL_KEY);

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
  const r = await fetch(SL_URL, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: xml, signal: AbortSignal.timeout(10000) });
  const body = await r.text();
  const code = Number((body.match(/\bres="(\d+)"/) || [])[1]);
  if (!r.ok || code !== 100) {
    const why = SL_ERRORS[code] || (body.match(/\brestxt="([^"]*)"/) || [])[1] || body.slice(0, 200);
    throw new Error(`Softline SMS xətası${Number.isNaN(code) ? ` (HTTP ${r.status})` : ` ${code}`}: ${why}`);
  }
  return { sent: true, response: body.slice(0, 200) };
}

async function sendSms(phone, text) {
  if (SOFTLINE) return sendSoftline(phone, text);
  if (!URL_T) return { sent: false, demo: true };
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

module.exports = { sendSms, configured: SOFTLINE || !!URL_T, provider: SOFTLINE ? "softline" : URL_T ? "url" : "demo" };
