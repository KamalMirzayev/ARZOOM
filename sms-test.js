// Serverdə SMS-i yoxlamaq üçün: docker compose exec app node sms-test.js 99450XXXXXXX
// Admin paneldə yazılmış Softline açarı bazadan oxunur, yoxdursa .env-dəki dəyərlər işləyir.
const Sms = require("./lib/sms");
const phone = String(process.argv[2] || "").replace(/\D/g, "");
if (!/^994\d{9}$/.test(phone)) { console.error("Nömrəni 994XXXXXXXXX formatında yaz, məs. 994501234567"); process.exit(1); }
(async () => {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg"); const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const { rows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'softline_%'");
      const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
      Sms.setSoftline({ user: v.softline_user, key: v.softline_key, sender: v.softline_sender });
    } catch (e) { /* settings table may not exist yet */ } finally { await pool.end(); }
  }
  if (Sms.provider() === "none") { console.error("SMS provayderi qoşulmayıb: admin paneldə (İstifadəçilər → SMS provayderi) Softline açarını yazın."); process.exit(1); }
  const r = await Sms.sendSms(phone, "Arzoom Avto: SMS yoxlaması. Bu mesaj gəldisə, SMS işləyir.");
  console.log(`Göndərildi (${Sms.provider()}): ${r.response}`);
})().catch(e => { console.error(e.message); process.exit(1); });
