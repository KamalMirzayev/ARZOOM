// AKB (Azərbaycan Kredit Bürosu) HUB web service, as in AKB's technical document "Məlumatların veb servis vasitəsilə əldə
// edilməsi": SOAP BorrowerInquiryWS over HTTPS with the organization's client certificate (issued via the Central Bank),
// login and password, from the static IP AKB allowed. inquireByIdCard returns an <inquiryResult> XML report; getBalance
// returns the deposit balance. The older REST score-report endpoint stays available as a second mode.
// Login, password and certificate live only in the settings table; they are never logged or sent back to the browser.
const https = require("https");

const SOAP_URLS = { test: "https://staging-hub.acb.az/soap/BorrowerInquiryWS", prod: "https://hub.acb.az/soap/BorrowerInquiryWS" };
const REST_URL = "https://staging-hub.acb.az/score-partner/score-report/ex";
// AKB error codes (section 5.4 of the document).
const INQ_ERRORS = {
  "INQ-003": "Şəxsin razılığının alındığı təsdiqlənmədi.", "INQ-004": "Sorğu məqsədi düzgün göstərilməmişdir.",
  "INQ-005": "Sənəd nömrəsi boşdur.", "INQ-006": "Sənədin seriyası boşdur.", "INQ-007": "FİN boşdur.", "INQ-008": "Şəxs mövcud deyil.",
  "INQ-009": "Sənəd nömrəsi və ya FİN düzgün deyil.", "INQ-010": "Doğum tarixi boşdur.", "INQ-011": "Sənəd nömrəsi və ya doğum tarixi düzgün deyil.",
  "INQ-012": "Razılıq üçün şəxsin FİN-i tələb olunur.",
  "INQ-015": "Sənəd seriyası üçün şablon tapılmadı: köhnə vəsiqə AZE + 8 rəqəm, yeni vəsiqə AA/AB + 7 rəqəm olmalıdır.", "INQ-018": "Bu şəxs haqqında son 30 dəqiqədə artıq sorğu edilib.",
  "INQ-019": "Skor yalnız gün ərzində tərtib olunmuş hesabat üzrə hesablana bilər.", "INQ-089": "AKB-də nəzərdə tutulmamış xəta baş verdi."
};
const xesc = s => String(s ?? "").replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const unesc = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");

// TLS options with the client certificate: a .pfx/.p12 (base64) with its passphrase, or PEM certificate and key.
function tls(c) {
  const o = {};
  if (c.pfx) { o.pfx = Buffer.from(c.pfx, "base64"); if (c.certPass) o.passphrase = c.certPass; }
  else if (c.certPem && c.keyPem) { o.cert = c.certPem; o.key = c.keyPem; if (c.certPass) o.passphrase = c.certPass; }
  return o;
}

// AKB is reached over the server's VPN, which carries only the host's own traffic. With AKB_RELAY set (in Docker:
// host.docker.internal), the app connects to the host's relay port for that AKB host (deploy/akb-relay.sh) and the relay
// connects to AKB from the host. TLS still runs end to end with AKB: SNI, certificate check and Host stay AKB's hostname.
const RELAY_PORTS = { "staging-hub.acb.az": 18443, "hub.acb.az": 18444 };
const relayFor = u => {
  const r = String(process.env.AKB_RELAY || "").trim();
  return r && r !== "off" && u.protocol === "https:" && RELAY_PORTS[u.hostname] && (!u.port || u.port === "443") ? { host: r, port: RELAY_PORTS[u.hostname] } : null;
};

function request(url, { method = "GET", headers = {}, body, tlsOpts = {}, timeout = 45000 }) {
  const started = Date.now();
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve({ ok: false, status: 0, error: "Ünvan düzgün deyil", ms: 0 }); }
    const lib = u.protocol === "http:" ? require("http") : https;
    const relay = relayFor(u);
    const target = relay ? { hostname: relay.host, port: relay.port, path: u.pathname + u.search, servername: u.hostname, headers: { Host: u.hostname, ...headers } }
      : { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers };
    const req = lib.request({ protocol: u.protocol, method, ...target, ...tlsOpts }, res => {
      const chunks = []; let size = 0;
      res.on("data", c => { size += c.length; if (size <= 4e6) chunks.push(c); });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, type: res.headers["content-type"] || "",
        text: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started }));
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", e => resolve({ ok: false, status: 0, ms: Date.now() - started,
      error: e.code === "TIMEOUT" ? `AKB ${timeout / 1000} saniyəyə cavab vermədi (${u.host}): çox güman AKB serverin IP ünvanına hələ icazə verməyib`
        : relay && e.code === "ECONNREFUSED" ? `AKB relay serverdə işləmir (${relay.host}:${relay.port}): deploy əmrini yenidən işlədin`
        : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT/.test(e.code || "") ? `AKB-ya qoşulmaq olmadı (${e.code}): AKB serverin IP ünvanına icazə verməlidir`
        : /CERT|SSL|TLS|EPROTO|mac verify|bad decrypt/i.test(`${e.code} ${e.message}`) ? `Sertifikat xətası: ${e.message}`
        : `AKB-ya qoşulmaq olmadı: ${e.code || e.message}` }));
    if (body) req.write(body);
    req.end();
  });
}

// The WSDL tells the namespace, the address to post to and whether the operation's child elements are namespace-qualified.
const wsdlCache = new Map();
async function describe(c) {
  const base = c.url || SOAP_URLS[c.env] || SOAP_URLS.test;
  const key = base + (c.pfx || c.certPem ? "#c" : "");
  const hit = wsdlCache.get(key); if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.d;
  const opts = { tlsOpts: tls(c), headers: auth(c), timeout: 30000 };
  const w = await request(base + "?wsdl", opts);
  if (!w.ok) throw new Error(w.error || `WSDL alınmadı (HTTP ${w.status})`);
  const ns = (w.text.match(/targetNamespace="([^"]+)"/) || [])[1];
  if (!ns) throw new Error("WSDL oxunmadı: targetNamespace tapılmadı");
  let schema = w.text;
  const loc = (w.text.match(/schemaLocation="([^"]+)"/) || [])[1];
  if (loc) { const x = await request(new URL(loc.replace(/&amp;/g, "&"), base).href, opts); if (x.ok) schema = x.text; }
  const d = { ns, address: (w.text.match(/<(?:\w+:)?address[^>]+location="([^"]+)"/) || [])[1] || base,
    qualified: /elementFormDefault="qualified"/.test(schema), ops: [...new Set([...w.text.matchAll(/<(?:\w+:)?operation name="([^"]+)"/g)].map(m => m[1]))] };
  wsdlCache.set(key, { at: Date.now(), d });
  return d;
}
const auth = c => c.user ? { Authorization: "Basic " + Buffer.from(`${c.user}:${c.pass}`).toString("base64") } : {};

function envelope(d, c, op, params) {
  const p = d.qualified ? "ns:" : "";
  const sec = c.user ? `<soapenv:Header><wsse:Security soapenv:mustUnderstand="0" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken><wsse:Username>${xesc(c.user)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${xesc(c.pass)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>` : "<soapenv:Header/>";
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${xesc(d.ns)}">${sec}<soapenv:Body><ns:${op}>${
    Object.entries(params).map(([k, v]) => `<${p}${k}>${xesc(v)}</${p}${k}>`).join("")}</ns:${op}></soapenv:Body></soapenv:Envelope>`;
}

async function soap(c, op, params) {
  let d; try { d = await describe(c); } catch (e) { return { ok: false, status: 0, error: e.message, ms: 0 }; }
  const r = await request(d.address, { method: "POST", tlsOpts: tls(c), body: envelope(d, c, op, params),
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""', Accept: "text/xml, */*", ...auth(c) } });
  if (r.text) {
    const fault = (r.text.match(/<(?:\w+:)?faultstring[^>]*>([\s\S]*?)<\/(?:\w+:)?faultstring>/) || [])[1];
    const code = (r.text.match(/INQ-\d{3}/) || [])[0];
    if (fault || code) { r.ok = false; r.error = code ? `${code}: ${INQ_ERRORS[code] || unesc(fault || "")}` : `AKB xətası: ${unesc(fault).slice(0, 300)}`; }
  }
  if (!r.ok && !r.error) r.error = r.status === 401 || r.status === 403 ? `AKB girişi qəbul etmədi (${r.status}): istifadəçi adı, parol və ya sertifikatı yoxlayın` : `AKB xətası ${r.status}`;
  return r;
}

async function query(c, { series, number, fin, purpose }) {
  if (c.mode === "rest") {
    const body = JSON.stringify({ accepted: true, purposeCode: purpose || c.purpose || "001", docSerie: series, documentNo: String(number), docType: "ID_CARD", pinCode: String(fin).toUpperCase() });
    const r = await request(c.url || REST_URL, { method: "POST", body, tlsOpts: tls(c), headers: { "Content-Type": "application/json", Accept: "application/json, */*", ...auth(c) } });
    if (!r.ok && !r.error) r.error = r.status === 401 || r.status === 403 ? `AKB girişi qəbul etmədi (${r.status})` : `AKB xətası ${r.status}`;
    return r;
  }
  // AKB matches the ID against its templates (document 5.5): AZE + 8 digits for old cards, AZE + AA + 7 digits for new ones.
  // How the service splits that into documentSerial / documentNo isn't written down, so the forms are tried in order on
  // INQ-015 ("no template for the series"); the form that works is remembered per series. A refused template is not an inquiry.
  const S = String(series).toUpperCase(), N = String(number).replace(/\D/g, "");
  const forms = S === "AZE" ? [["AZE", N], ["AZE", `AZE${N}`]] : [[S, N], [`AZE${S}`, N], ["AZE", `${S}${N}`]];
  const known = docForm.get(S) || 0;
  const order = [known, ...forms.keys()].filter((v, i, a) => a.indexOf(v) === i);
  let r;
  for (const i of order) {
    const [ds, dn] = forms[i];
    // Consent ("accept") is only ever true here: the server sends nothing unless staff confirmed the customer's written consent.
    r = await soap(c, "inquireByIdCard", { purposeCode: purpose || c.purpose || "001", accept: "true", documentSerial: ds, documentNo: dn,
      pinCode: String(fin).toUpperCase(), orgId: c.orgId || "", branchId: c.branchId || "", userId: c.userId || c.user || "" });
    if (!/INQ-015/.test(r.error || "")) { docForm.set(S, i); break; }
  }
  return r;
}
const docForm = new Map();

async function balance(c) {
  const r = await soap(c, "getBalance", {});
  if (!r.ok) return r;
  const v = (r.text.match(/<(?:\w+:)?(?:balance|return)>\s*([-\d.,]+)\s*</) || [])[1];
  return { ...r, balance: v != null ? Number(v.replace(",", ".")) : null };
}

// The <inquiryResult> report wherever it is in the answer: plain XML in the SOAP body (namespace prefixes dropped),
// escaped XML text, a JSON string field, or such a field in base64.
function findXml(text) {
  let t = String(text || "");
  if (t.includes("&lt;inquiryResult") || t.includes("&lt;ns")) { const u = unesc(t); if (/<(\w+:)?inquiryResult[\s>]/.test(u)) t = u; }
  // The live SOAP service returns the report's fields straight inside <return>, without the <inquiryResult> wrapper
  // shown in the document: wrap them so the parser sees the same report.
  if (!/<(\w+:)?inquiryResult[\s>]/.test(t)) {
    const r = t.match(/<((?:\w+:)?)return(?:\s[^>]*)?>([\s\S]*?)<\/\1return>/);
    if (r && /<(\w+:)?borrower[\s>]/.test(r[2]) && /<(\w+:)?reportId[\s>]/.test(r[2])) t = `<inquiryResult>${r[2]}</inquiryResult>`;
  }
  const m = t.match(/<((?:\w+:)?)inquiryResult[\s>][\s\S]*?<\/\1inquiryResult>/);
  if (m) return m[1] ? m[0].replace(new RegExp(`<(/?)${m[1]}`, "g"), "<$1").replace(/\sxmlns(:\w+)?="[^"]*"/g, "") : m[0].replace(/\sxmlns(:\w+)?="[^"]*"/g, "");
  let j; try { j = JSON.parse(t.trim()); } catch { return null; }
  const seen = new Set();
  const walk = v => {
    if (v == null || seen.has(v)) return null;
    if (typeof v === "string") {
      if (v.includes("<inquiryResult")) return findXml(v);
      if (v.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(v)) { const d = Buffer.from(v, "base64").toString("utf8"); if (d.includes("<inquiryResult")) return findXml(d); }
      return null;
    }
    if (typeof v === "object") { seen.add(v); for (const x of Object.values(v)) { const f = walk(x); if (f) return f; } }
    return null;
  };
  return walk(j);
}

// The shape of a JSON answer without its values, so an unknown format can be checked without personal data.
function shape(text, depth = 0) {
  let j = text;
  if (depth === 0) { try { j = JSON.parse(text); } catch { return null; } }
  if (Array.isArray(j)) return j.length ? [shape(j[0], depth + 1)] : [];
  if (j && typeof j === "object") return depth > 6 ? "{…}" : Object.fromEntries(Object.entries(j).slice(0, 60).map(([k, v]) => [k, shape(v, depth + 1)]));
  return j === null ? "null" : typeof j;
}
// Tag names of an XML answer without values, for the same purpose.
function xmlShape(text) {
  const tags = [...new Set([...String(text || "").matchAll(/<([\w:]+)[\s>/]/g)].map(m => m[1]))].filter(t => !/^(\?xml|!--)/.test(t));
  return tags.length ? tags.slice(0, 80) : null;
}

module.exports = { SOAP_URLS, REST_URL, INQ_ERRORS, query, balance, describe, findXml, shape, xmlShape, envelope };
