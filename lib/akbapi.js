// AKB (Azərbaycan Kredit Bürosu) score-report API: one POST per applicant with the ID card and FİN, Basic auth.
// The login and password live only in the settings table (typed in the panel) and are never logged or sent back.
const DEFAULT_URL = "https://staging-hub.acb.az/score-partner/score-report/ex";

async function query({ url, user, pass, purpose }, { series, number, fin }) {
  const started = Date.now();
  const body = { accepted: true, purposeCode: purpose || "001", docSerie: series, documentNo: String(number), docType: "ID_CARD", pinCode: String(fin).toUpperCase() };
  let r;
  try {
    r = await fetch(url, {
      method: "POST", signal: AbortSignal.timeout(45000),
      headers: { "Content-Type": "application/json", Accept: "application/json, application/xml, text/xml, */*",
                 Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const why = e.name === "TimeoutError" ? "AKB 45 saniyəyə cavab vermədi" : `AKB-ya qoşulmaq olmadı: ${e.cause?.code || e.message}`;
    return { ok: false, status: 0, error: why, ms: Date.now() - started };
  }
  const text = (await r.text()).slice(0, 4e6);
  const type = r.headers.get("content-type") || "";
  const out = { ok: r.ok, status: r.status, type, text, ms: Date.now() - started };
  if (!r.ok) out.error = r.status === 401 || r.status === 403 ? `AKB girişi qəbul etmədi (${r.status}): istifadəçi adı, parol və ya serverin IP icazəsini yoxlayın`
    : `AKB xətası ${r.status}${short(text) ? `: ${short(text)}` : ""}`;
  return out;
}
// A short error text from AKB's response for the panel: the message field of a JSON error, otherwise the first 200 characters.
function short(text) {
  try { const j = JSON.parse(text); const m = j.message || j.error || j.detail || j.title; if (m) return String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 200); } catch {}
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// The credit report as XML (the format lib/akb.js reads), wherever it is in the answer: the body itself, a string field
// in a JSON answer, or such a field in base64.
function findXml(text) {
  const t = String(text || "").trim();
  if (t.startsWith("<")) return t.includes("inquiryResult") ? t : null;
  let j; try { j = JSON.parse(t); } catch { return null; }
  const seen = new Set();
  const walk = v => {
    if (v == null || seen.has(v)) return null;
    if (typeof v === "string") {
      if (v.includes("<inquiryResult")) return v;
      if (v.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(v)) { const d = Buffer.from(v, "base64").toString("utf8"); if (d.includes("<inquiryResult")) return d; }
      return null;
    }
    if (typeof v === "object") { seen.add(v); for (const x of Object.values(v)) { const f = walk(x); if (f) return f; } }
    return null;
  };
  return walk(j);
}

// The shape of a JSON answer without its values (key names and types), so the format can be checked without personal data.
function shape(text, depth = 0) {
  let j = text;
  if (depth === 0) { try { j = JSON.parse(text); } catch { return null; } }
  if (Array.isArray(j)) return j.length ? [shape(j[0], depth + 1)] : [];
  if (j && typeof j === "object") return depth > 6 ? "{…}" : Object.fromEntries(Object.entries(j).slice(0, 60).map(([k, v]) => [k, shape(v, depth + 1)]));
  return j === null ? "null" : typeof j;
}

module.exports = { DEFAULT_URL, query, findXml, shape };
