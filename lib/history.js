// "Tarixçə və qeydlər" for the partner (Bitrix): the whole timeline of an application as the panel shows it, sent as
// event "history". Credit bureau and income document readings stay in ARZOOM; partner notifications are not repeated.
const { CALL_RESULTS, ROBO_RESULTS, EXPORT_STATUS } = require("./labels");

const money = x => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " AZN";
const TITLES = { call_requeue: "ArzoomCall-a yenidən zəng sifariş edildi", partner_ref: "Partnyor ref nömrəsi əlavə edildi",
  info_request: "Müştəridən əlavə məlumat istənildi", info_reply: "Müştəri əlavə məlumat göndərdi", created: "Müraciət daxil oldu",
  assessed: "Qiymətləndirildi", offer: "Təklif göndərildi", reoffer: "Müştəri başqa şərt istəyir: təkrar təklif", rejected: "Müraciət rədd edildi",
  note: "Qeyd", accepted: "Müştəri son təklifi təsdiqlədi: anderraytinqə və satışa ötürüldü", declined: "Müştəri təklifdən imtina etdi",
  cancelled: "Müştəri müraciəti ləğv etdi", sms: "SMS" };
const SKIP = new Set(["webhook", "bureau", "doc_analysis"]);

function entry(e) {
  const d = e.details || {};
  const title = e.kind === "accepted" && d.via === "robocall" ? "ArzoomCall müştərini satış təmsilçisinə qoşdu: satışa ötürüldü"
    : e.kind === "note" && d.channel === "robocall" ? "ArzoomCall zənginin nəticəsi"
    : e.kind === "note" && CALL_RESULTS[d.outcome] ? (d.channel === "meeting" ? "Fiziki görüşün nəticəsi" : "Telefon danışığının nəticəsi")
    : e.kind === "sms" ? `SMS${d.to ? " → " + d.to : ""}` : TITLES[e.kind] || e.kind;
  const text = e.kind === "assessed" ? `${d.score} bal, ${d.grade}`
    : e.kind === "offer" ? `${money(d.price)}, ilkin ${d.downPct}%, ${d.months} ay, illik ${d.rate}%`
    : e.kind === "reoffer" ? [d.label, d.reason].filter(Boolean).join(" · ")
    : e.kind === "rejected" ? d.reason || ""
    : e.kind === "note" ? [d.channel === "robocall" ? (d.outcome_label || ROBO_RESULTS[d.outcome]) : CALL_RESULTS[d.outcome], d.text].filter(Boolean).join(" · ")
    : e.kind === "sms" ? (d.error ? "Göndərilmədi: " + d.error : d.text || "")
    : e.kind === "info_request" ? d.text || "" : e.kind === "info_reply" ? [d.text, d.files ? `${d.files} sənəd` : ""].filter(Boolean).join(" · ")
    : e.kind === "created" ? `${d.files || 0} sənəd` : e.kind === "accepted" && d.downPct != null ? `ilkin ödəniş ${d.downPct}%`
    : e.kind === "partner_ref" ? d.ref || "" : "";
  return { at: new Date(e.at).toISOString(), kind: e.kind, title, text: String(text || ""), actor: e.actor === "Robocall" ? "ArzoomCall" : e.actor };
}

// The request body for one application, or null when it has no partner ref (nothing goes to the partner then).
async function build(pool, id) {
  const { rows } = await pool.query("SELECT id, partner_ref, status FROM applications WHERE id = $1", [id]);
  const a = rows[0]; if (!a?.partner_ref) return null;
  const ev = await pool.query("SELECT kind, actor, details, at FROM application_events WHERE application_id = $1 ORDER BY at, id", [id]);
  return { event: "history", external_id: a.partner_ref, application_id: a.id, date: new Date().toISOString(),
           status: a.status, status_label: EXPORT_STATUS[a.status] || a.status,
           history: ev.rows.filter(e => !SKIP.has(e.kind)).map(entry).slice(-300) };
}

// Sends the body to the partner webhook; returns an error text, or null when it was accepted.
async function post(wh, body) {
  try {
    const res = await fetch(wh.url, { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", ...(wh.token ? { "X-Api-Key": wh.token } : {}) }, body: JSON.stringify(body) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) { return e.name === "TimeoutError" ? "cavab gəlmədi (10 san.)" : "qoşulmaq olmadı"; }
}

module.exports = { build, post, entry };
