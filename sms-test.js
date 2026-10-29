// Serverdə SMS-i yoxlamaq üçün: docker compose exec app node sms-test.js 99450XXXXXXX
const { sendSms, provider } = require("./lib/sms");
const phone = String(process.argv[2] || "").replace(/\D/g, "");
if (!/^994\d{9}$/.test(phone)) { console.error("Nömrəni 994XXXXXXXXX formatında yaz, məs. 994501234567"); process.exit(1); }
if (provider === "demo") { console.error("SMS provayderi qoşulmayıb: .env-də SOFTLINE_USER və SOFTLINE_KEY yoxdur."); process.exit(1); }
sendSms(phone, "Arzoom Avto: SMS yoxlaması. Bu mesaj gəldisə, SMS işləyir.")
  .then(r => console.log(`Göndərildi (${provider}): ${r.response}`))
  .catch(e => { console.error(e.message); process.exit(1); });
