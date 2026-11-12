// Shows the "history" request (Tarixçə və qeydlər) that goes to the partner (Bitrix) for one application.
//   Baxmaq (heç nə göndərmir):  cd /opt/arzoom && sudo docker compose exec -T app node bitrix-history.js NLEZ-0105
//   Bitrix-ə indi göndərmək:    cd /opt/arzoom && sudo docker compose exec -T app node bitrix-history.js NLEZ-0105 --send
const { Pool } = require("pg");
const History = require("./lib/history");

const id = process.argv.slice(2).find(a => !a.startsWith("--"));
const SEND = process.argv.includes("--send");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  if (!id) throw new Error("Müraciət nömrəsini yazın, məs.: node bitrix-history.js NLEZ-0105");
  const exists = await pool.query("SELECT partner_ref FROM applications WHERE id = $1", [id]);
  if (!exists.rowCount) throw new Error(`${id} tapılmadı.`);
  const body = await History.build(pool, id);
  if (!body) throw new Error(`${id} müraciətində partnyor ref nömrəsi yoxdur, ona görə Bitrix-ə heç nə getmir.`);
  console.log(JSON.stringify(body, null, 2));
  if (SEND) {
    const s = await pool.query("SELECT key, value FROM settings WHERE key IN ('partner_webhook_url','partner_webhook_token')");
    const v = Object.fromEntries(s.rows.map(r => [r.key, r.value]));
    if (!v.partner_webhook_url) throw new Error("Partnyor webhook-u qoşulmayıb.");
    const error = await History.post({ url: v.partner_webhook_url, token: v.partner_webhook_token }, body);
    console.log(error ? `Göndərilmədi: ${error}` : "Bitrix-ə göndərildi.");
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
