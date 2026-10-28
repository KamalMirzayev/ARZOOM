// Əməkdaş icazələri. Rol standart dəsti verir, admin hər istifadəçi üçün dəsti dəyişə bilər.
// İstifadəçi idarəsi yalnız admin roluna aiddir və ayrıca verilmir.
const PERMS = {
  "apps.view": "Müraciətlərə baxmaq",
  "docs.view": "Sənədləri açmaq",
  "apps.notes": "Qeyd yazmaq",
  "apps.assess": "Qiymətləndirmək və AKB hesabatı yükləmək",
  "apps.offer": "Təklif göndərmək",
  "apps.reject": "Müraciəti rədd etmək",
  "apps.delete": "Müraciəti silmək",
  "analytics.view": "Analitikaya baxmaq"
};
const ALL = Object.keys(PERMS);
const ROLE_DEFAULTS = {
  admin: ALL,
  expert: ["apps.view", "docs.view", "apps.notes", "apps.assess", "apps.offer", "apps.reject", "analytics.view"],
  sales: ["apps.view", "docs.view", "apps.notes"]
};
// apps.view is always on: without it the panel has nothing to show.
function effective(user) {
  if (user.role === "admin") return [...ALL, "users.manage"];
  const list = Array.isArray(user.permissions) ? user.permissions.filter(p => PERMS[p]) : ROLE_DEFAULTS[user.role] || [];
  return [...new Set(["apps.view", ...list])];
}
const clean = list => Array.isArray(list) ? [...new Set(list.filter(p => PERMS[p]))] : null;
module.exports = { PERMS, ROLE_DEFAULTS, effective, clean };
