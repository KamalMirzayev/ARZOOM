// Build step: the site's own inline scripts are allowed by hash instead of 'unsafe-inline'.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = path.join(__dirname, "public");
const hashes = new Set();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".html")))
  for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g))
    if (!/\bsrc=/.test(m[1] || "") && !/application\/ld\+json/.test(m[1] || ""))
      hashes.add(`'sha256-${crypto.createHash("sha256").update(m[2]).digest("base64")}'`);
const file = path.join(__dirname, "Caddyfile");
const src = fs.readFileSync(file, "utf8");
if (!src.includes("script-src 'self' 'unsafe-inline'")) throw new Error("Caddyfile: script-src not found");
fs.writeFileSync(file, src.replace("script-src 'self' 'unsafe-inline'", `script-src 'self' ${[...hashes].join(" ")}`));
console.log(`CSP: ${hashes.size} inline script hash`);
