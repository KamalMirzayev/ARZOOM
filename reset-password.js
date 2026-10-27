// Unudulmuş parolu serverdə bərpa etmək üçün:
//   cd /opt/arzoom && sudo docker compose exec app node reset-password.js admin 'YeniParol123'
const { Pool } = require("pg");
const { hashPassword, weakPassword } = require("./lib/passwords");
const [username, password] = process.argv.slice(2);
if (!username || !password) { console.error("İstifadə: node reset-password.js <istifadəçi> <yeni parol>"); process.exit(1); }
const w = weakPassword(password); if (w) { console.error(w); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  `INSERT INTO staff_users (username, name, password_hash, role) VALUES ($1, $1, $2, 'admin')
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true RETURNING id`,
  [username.toLowerCase(), hashPassword(password)])
  .then(() => pool.query("DELETE FROM staff_sessions WHERE user_id = (SELECT id FROM staff_users WHERE username = $1)", [username.toLowerCase()]))
  .then(() => { console.log(`${username} üçün parol yeniləndi.`); return pool.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
