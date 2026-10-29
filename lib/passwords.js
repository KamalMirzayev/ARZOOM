// Parol hash-ləri: scrypt + təsadüfi duz. Format: scrypt$<salt>$<hash>
const crypto = require("crypto");
const hashPassword = pw => {
  const salt = crypto.randomBytes(16).toString("base64url");
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString("base64url")}`;
};
const checkPassword = (pw, stored) => {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(hash, "base64url");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// Policy for new passwords: long enough to resist guessing behind the login rate limit.
const COMMON = /^(password|parol|qwerty|admin|arzoom|123456|111111|000000|abc123)/i;
const weakPassword = (pw, username = "") => {
  const p = String(pw || "");
  if (p.length < 10) return "Parol ən azı 10 simvol olmalıdır.";
  if (p.length > 200) return "Parol çox uzundur.";
  if (!/\p{L}/u.test(p) || !/\d/.test(p)) return "Parolda həm hərf, həm rəqəm olmalıdır.";
  if (/^(.)\1+$/.test(p) || COMMON.test(p) || (username && p.toLowerCase().includes(String(username).toLowerCase())))
    return "Bu parolu təxmin etmək asandır, başqasını seç.";
  return null;
};
module.exports = { hashPassword, checkPassword, weakPassword };
