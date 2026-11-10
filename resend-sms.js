// Softline "xəta 20" ilə getməyən müştəri SMS-lərini təkrar göndərir: hər müştəriyə yalnız sonuncu SMS-i,
// o da sonuncu cəhd xəta ilə bitibsə. Göndərişlər arasında ən az 1 dəqiqə fasilə olur.
//   Siyahıya baxmaq (heç nə göndərmir):  cd /opt/arzoom && sudo docker compose exec app node resend-sms.js
//   Göndərmək:                           cd /opt/arzoom && sudo docker compose exec app node resend-sms.js --send
const { Pool } = require("pg");
const Sms = require("./lib/sms");

const SEND = process.argv.includes("--send");
const GAP = 61000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const s = await pool.query("SELECT key, value FROM settings WHERE key IN ('softline_user','softline_key','softline_sender')");
  const v = Object.fromEntries(s.rows.map(r => [r.key, r.value]));
  Sms.setSoftline({ user: v.softline_user, key: v.softline_key, sender: v.softline_sender });
  if (SEND && !Sms.configured()) throw new Error("SMS provayderi qoşulmayıb");

  // Latest customer SMS of each application; kept only if it failed with error 20. Then one per phone number.
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (a.phone) a.id, a.phone, l.details->>'text' AS text, l.details->>'error' AS error, l.at
      FROM applications a
      JOIN LATERAL (SELECT e.at, e.details FROM application_events e
                     WHERE e.application_id = a.id AND e.kind = 'sms' AND e.details->>'to' = 'Müştəri'
                     ORDER BY e.at DESC LIMIT 1) l ON true
     WHERE l.details->>'error' LIKE '%xətası 20%' AND coalesce(l.details->>'text', '') <> ''
     ORDER BY a.phone, l.at DESC`);

  console.log(`Təkrar göndəriləcək: ${rows.length} müştəri${SEND ? "" : " (yoxlama rejimi, göndərmək üçün --send)"}`);
  let ok = 0, fail = 0;
  for (const [i, r] of rows.entries()) {
    const masked = "+" + r.phone.replace(/^(\d{5})\d+(\d{2})$/, "$1*****$2");
    if (!SEND) { console.log(`${r.id}  ${masked}  ${r.text.slice(0, 70)}…`); continue; }
    if (i) await sleep(GAP);
    try {
      await Sms.sendSms(r.phone, r.text);
      await pool.query("INSERT INTO application_events (application_id, actor, kind, details) VALUES ($1,'Sistem','sms',$2)",
        [r.id, { to: "Müştəri", text: r.text, resent: true }]);
      ok++; console.log(`✓ ${r.id}  ${masked}`);
    } catch (e) {
      await pool.query("INSERT INTO application_events (application_id, actor, kind, details) VALUES ($1,'Sistem','sms',$2)",
        [r.id, { to: "Müştəri", text: r.text, resent: true, error: e.message }]).catch(() => {});
      fail++; console.log(`✗ ${r.id}  ${masked}  ${e.message}`);
    }
  }
  if (SEND) console.log(`Hazırdır: göndərildi ${ok}, xəta ${fail}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
