// SMS göndərişi. Provayder .env-də SMS_URL ilə qoşulur; {phone} və {text} yerinə nömrə və mətn yazılır.
//   GET nümunəsi:  SMS_URL=https://sms.provider.az/send?login=LOGIN&key=KEY&msisdn={phone}&text={text}
//   POST nümunəsi: SMS_METHOD=POST, SMS_BODY={"to":"{phone}","message":"{text}"},
//                  SMS_HEADERS={"Authorization":"Bearer TOKEN","Content-Type":"application/json"}
const URL_T = process.env.SMS_URL || "";
const METHOD = (process.env.SMS_METHOD || "GET").toUpperCase();
const BODY_T = process.env.SMS_BODY || "";
let HEADERS = {};
try { HEADERS = JSON.parse(process.env.SMS_HEADERS || "{}"); } catch { console.error("SMS_HEADERS JSON deyil, nəzərə alınmadı."); }

const fill = (t, vars, enc) => t.replace(/\{(phone|text)\}/g, (_, k) => enc(vars[k]));
const jsonEnc = s => JSON.stringify(String(s)).slice(1, -1);

async function sendSms(phone, text) {
  if (!URL_T) return { sent: false, demo: true };
  const vars = { phone, text };
  const opts = { method: METHOD, headers: HEADERS, signal: AbortSignal.timeout(10000) };
  if (METHOD !== "GET" && BODY_T) opts.body = fill(BODY_T, vars, BODY_T.trim().startsWith("{") ? jsonEnc : encodeURIComponent);
  const r = await fetch(fill(URL_T, vars, encodeURIComponent), opts);
  const body = await r.text();
  if (!r.ok) throw new Error(`SMS provayderi ${r.status}: ${body.slice(0, 200)}`);
  return { sent: true, response: body.slice(0, 200) };
}

module.exports = { sendSms, configured: !!URL_T };
