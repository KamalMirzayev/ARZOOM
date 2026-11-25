// End-of-day application report: what came in today, what was decided, what still waits. Mailed every day to the
// addresses an admin sets in the panel. No names, FİN, phone numbers, income, interest or commission: only counts and,
// per application, its number, brand, model, source and status.
const DAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Baku') AT TIME ZONE 'Asia/Baku')";
const STATUS = { review: "Baxılır", info: "Əlavə məlumat gözlənilir", offer: "Təklif göndərilib", reoffer: "Təkrar təklif gözləyir",
  rejected: "Rədd edilib", accepted: "Satışa ötürülüb", declined: "Müştəri imtina etdi", cancelled: "Ləğv edilib" };

async function build(pool) {
  const [day, made, events, open, sold, list] = await Promise.all([
    pool.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Baku', 'DD.MM.YYYY') AS d`),
    pool.query(`SELECT brand, count(*)::int AS n FROM applications WHERE created_at >= ${DAY} GROUP BY brand ORDER BY n DESC, brand`),
    pool.query(`SELECT kind, count(DISTINCT application_id)::int AS n FROM application_events
                WHERE at >= ${DAY} AND kind IN ('offer','rejected','info_request','accepted','declined','cancelled','reoffer') GROUP BY kind`),
    pool.query(`SELECT status, count(*)::int AS n, floor(extract(epoch FROM now() - min(updated_at)) / 86400)::int AS oldest
                FROM applications WHERE status IN ('review','info','reoffer','offer') GROUP BY status`),
    pool.query(`SELECT coalesce(sum((offer->>'price')::numeric), 0)::float AS amount FROM applications a WHERE offer ? 'price'
                  AND EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = a.id AND e.kind = 'accepted' AND e.at >= ${DAY})`),
    // Every application touched today: new ones and ones with a decision or a customer answer.
    pool.query(`SELECT id, brand, model, status, partner, to_char(created_at AT TIME ZONE 'Asia/Baku', 'DD.MM HH24:MI') AS created,
                       created_at >= ${DAY} AS new
                FROM applications a WHERE created_at >= ${DAY} OR EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = a.id
                  AND e.at >= ${DAY} AND e.kind IN ('offer','rejected','info_request','info_reply','accepted','declined','cancelled','reoffer','reoffer_declined'))
                ORDER BY created_at DESC LIMIT 300`)
  ]);
  const ev = Object.fromEntries(events.rows.map(r => [r.kind, r.n]));
  const st = Object.fromEntries(open.rows.map(r => [r.status, r]));
  return {
    date: day.rows[0].d,
    created: { total: made.rows.reduce((s, r) => s + r.n, 0), byBrand: made.rows },
    decided: { offer: ev.offer || 0, rejected: ev.rejected || 0, info: ev.info_request || 0, accepted: ev.accepted || 0,
               declined: ev.declined || 0, cancelled: ev.cancelled || 0, reoffer: ev.reoffer || 0 },
    soldAmount: sold.rows[0].amount,
    waiting: Object.fromEntries(["review", "info", "reoffer", "offer"].map(s => [s, { n: st[s]?.n || 0, oldest: st[s]?.oldest || 0 }])),
    items: list.rows
  };
}

const money = x => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " AZN";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const old = x => x.n && x.oldest >= 1 ? ` (ən köhnəsi ${x.oldest} gün)` : "";

function lines(r) {
  const d = r.decided, w = r.waiting;
  return {
    created: [["Yeni müraciət", r.created.total], ...r.created.byBrand.map(b => [`  ${b.brand}`, b.n])],
    decided: [["Təklif göndərilib", d.offer], ["Rədd edilib", d.rejected], ["Əlavə məlumat istənib", d.info],
              ["Satışa ötürülüb", d.accepted + (d.accepted && r.soldAmount ? `, avtomobillərin dəyəri ${money(r.soldAmount)}` : "")], ["Müştəri imtina etdi", d.declined],
              ["Ləğv edilib", d.cancelled], ["Müştəri təkrar təklif istədi", d.reoffer]],
    waiting: [["Baxılır", w.review.n + old(w.review)], ["Əlavə məlumat gözlənilir", w.info.n], ["Təkrar təklif gözləyir", w.reoffer.n + old(w.reoffer)],
              ["Təklif göndərilib, müştəri cavabı gözlənilir", w.offer.n]]
  };
}

function subject(r) { return `Arzoom Avto: gün sonu hesabatı, ${r.date}`; }

function text(r, panelUrl) {
  const L = lines(r), block = (t, rows) => `${t}\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  return [subject(r), block("Bu gün daxil olub", L.created), block("Bu günün nəticələri", L.decided), block("Gün sonu gözləyir", L.waiting),
    r.items.length ? "Bu gün hərəkət olan müraciətlər\n" + r.items.map(a => `№ ${a.id} · ${a.brand} ${a.model} · ${STATUS[a.status] || a.status}${a.partner ? ` · ${a.partner}` : ""}`).join("\n") : "",
    panelUrl ? `Panel: ${panelUrl}/admin` : ""].filter(Boolean).join("\n\n");
}

function html(r, panelUrl) {
  const L = lines(r);
  const table = (t, rows) => `<h3 style="margin:22px 0 8px;font:600 15px system-ui,sans-serif;color:#1d2433">${t}</h3>
    <table style="border-collapse:collapse;width:100%;max-width:520px;font:14px system-ui,sans-serif">${rows.map(([k, v]) =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #e6e8ee;color:#4a5263">${esc(k).replace(/^ {2}/, "&nbsp;&nbsp;&nbsp;")}</td><td style="padding:6px 10px;border-bottom:1px solid #e6e8ee;text-align:right;font-weight:600">${esc(v)}</td></tr>`).join("")}</table>`;
  const items = r.items.length ? `<h3 style="margin:22px 0 8px;font:600 15px system-ui,sans-serif;color:#1d2433">Bu gün hərəkət olan müraciətlər</h3>
    <table style="border-collapse:collapse;width:100%;font:13px system-ui,sans-serif"><tr style="background:#f3f4f8">${["№", "Daxil olub", "Marka, model", "Mənbə", "Status"].map(h => `<th style="padding:6px 8px;text-align:left">${h}</th>`).join("")}</tr>
    ${r.items.map(a => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e6e8ee;font-family:monospace">${esc(a.id)}</td><td style="padding:6px 8px;border-bottom:1px solid #e6e8ee">${esc(a.created)}${a.new ? " · yeni" : ""}</td><td style="padding:6px 8px;border-bottom:1px solid #e6e8ee">${esc(a.brand)} ${esc(a.model)}</td><td style="padding:6px 8px;border-bottom:1px solid #e6e8ee">${esc(a.partner || "sayt")}</td><td style="padding:6px 8px;border-bottom:1px solid #e6e8ee">${esc(STATUS[a.status] || a.status)}</td></tr>`).join("")}</table>` : "";
  return `<div style="max-width:720px;margin:0 auto;padding:20px;color:#1d2433">
    <h2 style="margin:0 0 4px;font:600 20px system-ui,sans-serif">Gün sonu hesabatı</h2><div style="color:#6b7385;font:14px system-ui,sans-serif">Arzoom Avto · ${esc(r.date)}</div>
    ${table("Bu gün daxil olub", L.created)}${table("Bu günün nəticələri", L.decided)}${table("Gün sonu gözləyir", L.waiting)}${items}
    ${panelUrl ? `<p style="margin:24px 0 0;font:14px system-ui,sans-serif"><a href="${esc(panelUrl)}/admin" style="color:#4F5BD5">Paneli aç</a></p>` : ""}</div>`;
}

// "HH:MM" and the calendar date in Baku (UTC+4, no daylight saving).
function bakuNow(now = Date.now()) {
  const t = new Date(now + 4 * 3600e3).toISOString();
  return { date: t.slice(0, 10), hm: t.slice(11, 16) };
}

module.exports = { build, subject, text, html, bakuNow };
