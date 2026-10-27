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
const weakPassword = pw => String(pw || "").length < 10 ? "Parol ən azı 10 simvol olmalıdır." : null;
module.exports = { hashPassword, checkPassword, weakPassword };
