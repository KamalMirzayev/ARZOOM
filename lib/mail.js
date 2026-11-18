// E-mail to managers: through Microsoft 365 (Graph API, app registration with Mail.Send) or any SMTP server.
// Settings are typed once in the panel (settings table). The secret (client secret or SMTP password) never goes back
// to the browser or into a log.
const nodemailer = require("nodemailer");

const C = { provider: "", tenant: "", clientId: "", host: "", port: 587, user: "", from: "", to: [], onSale: true, dailyAt: "", secret: "" };
let graphToken = { value: "", until: 0 };
let smtp = null;

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const list = v => String(v || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

function configure(cfg = {}, secret = "") {
  Object.assign(C, {
    provider: ["ms365", "smtp"].includes(cfg.provider) ? cfg.provider : "",
    tenant: cfg.tenant || "", clientId: cfg.clientId || "", host: cfg.host || "", port: Number(cfg.port) || 587,
    user: cfg.user || "", from: cfg.from || "", to: Array.isArray(cfg.to) ? cfg.to : list(cfg.to),
    onSale: cfg.onSale !== false, dailyAt: /^\d{2}:\d{2}$/.test(cfg.dailyAt || "") ? cfg.dailyAt : "", secret: secret || ""
  });
  graphToken = { value: "", until: 0 }; smtp = null;
}
const ready = () => !!(C.provider && C.from && C.to.length && C.secret &&
  (C.provider === "ms365" ? C.tenant && C.clientId : C.host));
// What the panel may see: everything except the secret.
const publicConfig = () => ({ provider: C.provider, tenant: C.tenant, clientId: C.clientId, host: C.host, port: C.port, user: C.user,
  from: C.from, to: C.to, onSale: C.onSale, dailyAt: C.dailyAt, secretSet: !!C.secret, ready: ready() });

// Checks a config from the panel; returns an error text or null.
function validate(cfg) {
  if (!["ms365", "smtp"].includes(cfg.provider)) return "Göndərmə üsulunu seç: Microsoft 365 və ya SMTP.";
  if (!EMAIL.test(cfg.from || "")) return "Göndərən e-poçt ünvanı düzgün deyil.";
  const to = list(cfg.to);
  if (!to.length) return "Ən azı bir alıcı e-poçtu yaz.";
  if (to.length > 30) return "Alıcı çox çoxdur (ən çox 30).";
  const badTo = to.find(a => !EMAIL.test(a)); if (badTo) return `Alıcı ünvanı düzgün deyil: ${badTo}`;
  if (cfg.provider === "ms365") {
    if (!/^[0-9a-f-]{36}$|^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cfg.tenant || "")) return "Tenant ID düzgün deyil (GUID və ya domen).";
    if (!/^[0-9a-f-]{36}$/i.test(cfg.clientId || "")) return "Client (Application) ID düzgün deyil.";
  } else {
    if (!/^[a-z0-9.-]+$/i.test(cfg.host || "")) return "SMTP serveri düzgün deyil (məs. smtp.office365.com).";
    const p = Number(cfg.port); if (!Number.isInteger(p) || p < 1 || p > 65535) return "SMTP portu düzgün deyil.";
  }
  if (cfg.dailyAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.dailyAt)) return "Gündəlik hesabat vaxtı SS:DD formasında olmalıdır.";
  return null;
}

async function graphAccessToken() {
  if (graphToken.value && Date.now() < graphToken.until) return graphToken.value;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(C.tenant)}/oauth2/v2.0/token`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: C.clientId, client_secret: C.secret,
                                scope: "https://graph.microsoft.com/.default" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Microsoft 365 girişi alınmadı: ${j.error || r.status}${j.error_description ? " (" + String(j.error_description).split("\r\n")[0].slice(0, 160) + ")" : ""}`);
  graphToken = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120e3 };
  return graphToken.value;
}

async function send({ subject, html, to = C.to }) {
  if (!ready()) throw new Error("E-poçt qoşulmayıb.");
  if (C.provider === "ms365") {
    const token = await graphAccessToken();
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(C.from)}/sendMail`, {
      method: "POST", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ saveToSentItems: true, message: { subject, body: { contentType: "HTML", content: html },
        toRecipients: to.map(address => ({ emailAddress: { address } })) } }) });
    if (r.status !== 202 && !r.ok) {
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) graphToken = { value: "", until: 0 };
      throw new Error(`Microsoft 365 məktubu qəbul etmədi (${r.status}${j.error?.code ? ", " + j.error.code : ""})${r.status === 403 ? ": tətbiqə Mail.Send icazəsi (Application) verilməyib və ya admin təsdiqi yoxdur." : ""}`);
    }
    return;
  }
  smtp = smtp || nodemailer.createTransport({ host: C.host, port: C.port, secure: C.port === 465, requireTLS: C.port === 587,
    auth: { user: C.user || C.from, pass: C.secret }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  try { await smtp.sendMail({ from: C.from, to: to.join(", "), subject, html }); }
  catch (e) { smtp = null; throw new Error(`SMTP xətası: ${e.code || ""} ${String(e.response || e.message).slice(0, 200)}`.trim()); }
}

module.exports = { C, configure, ready, publicConfig, validate, send, list };
