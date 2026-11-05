"use strict";
// Partner stock and prices (Group Motors knowledge base, GET {origin}/credit/kb/{token}).
// The base is free text for a chat bot; price lists are chunks with category "price" whose lines look like
//   • Seal 6 DM-i 128km Active (2026) — 38 300 AZN — note
// Each line is one trim on sale. The model is the name up to the first trim word (DM-i, EV, AWD, 120km, ...).
// A brand without a price list falls back to its spec sheets (see parseSpecs).

const LINE = /^\s*[•*-]\s*(.+?)\s*\((\d{4})\)\s*[—–-]\s*([\d\s.,]+)\s*AZN\b/i;
const TRIM_WORD = /^(DM-?i|DM-?p|DM|EV|PHEV|HEV|AWD|4WD|2WD|FWD|RWD|Advanced|Premium|Hybrid|\d+\s*km)$/i;
const PT = t => (/\bEV\b/i.test(t) ? "E" : /\bDM-?[ip]?\b|PHEV/i.test(t) ? "P" : /\bHEV\b|hybrid/i.test(t) ? "H" : "");

// Our brand name, or a new brand from the partner (e.g. "chery" becomes "Chery"); "common" chunks belong to no brand.
function brandOf(byName, slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s || s === "common" || !/^[a-z0-9 -]{2,30}$/.test(s)) return null;
  return byName[s] || s.replace(/(^|[ -])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

function modelOf(name) {
  const words = name.split(/\s+/), out = [];
  for (const w of words) { if (TRIM_WORD.test(w) && out.length) break; out.push(w); }
  // "Shark 6 Advanced": the model stops before a known trim word; without one, keep the first two words.
  return (out.length === words.length && words.length > 2 ? words.slice(0, 2) : out).join(" ");
}

// chunks: the "chunks" array of the knowledge base. brands: our brand names (case decides the output key).
function parse(chunks, brands) {
  const byName = Object.fromEntries(brands.map(b => [b.toLowerCase(), b]));
  const out = {};
  for (const c of chunks || []) {
    if (c?.category !== "price" || typeof c.content !== "string") continue;
    if (c.valid_until && new Date(c.valid_until + "T23:59:59+04:00") < new Date()) continue;
    const brand = brandOf(byName, c.brand);
    if (!brand) continue;
    const models = out[brand] || (out[brand] = {});
    for (const line of c.content.split("\n")) {
      const m = line.match(LINE);
      if (!m) continue;
      const name = m[1].replace(/\s+/g, " ").trim(), price = Number(m[3].replace(/[\s.,]/g, ""));
      if (!name || !(price >= 1000 && price <= 1e7)) continue;
      const model = modelOf(name);
      const g = models[model] || (models[model] = { model, pt: "", trims: [] });
      const full = `${name} (${m[2]})`;
      if (!g.trims.some(t => t.name === full)) g.trims.push({ name: full, year: +m[2], price, pt: PT(name) });
    }
  }
  const res = {};
  for (const [brand, models] of Object.entries(out)) {
    const list = Object.values(models).map(g => {
      g.trims.sort((a, b) => a.price - b.price);
      const pts = [...new Set(g.trims.map(t => t.pt).filter(Boolean))];
      return { model: g.model, pt: pts.length === 1 ? pts[0] : "", from: g.trims[0].price, trims: g.trims };
    }).sort((a, b) => a.from - b.from);
    if (list.length) res[brand] = list;
  }
  // Brands without a price list: models and trims from the spec sheets, priced by their "Qiymət ƏDV Daxil" line.
  const specs = parseSpecs(chunks, byName);
  for (const [brand, list] of Object.entries(specs)) if (!res[brand]) res[brand] = list;
  return res;
}

// Spec sheets: one summary chunk per model ("Toyota Land Cruiser 300 / комплектации — сводка") and chunks per trim
// (c.trim set) for each section; one of the sections carries "Qiymət ƏDV Daxil: 36700 AZN".
const SPEC_PRICE = /Qiym(?:ə|e)t\s+ƏDV\s+daxil\s*:\s*([\d\s.,]+)\s*(?:AZN|₼|manat)/i;
const clean = s => String(s || "").replace(/[^\p{L}\p{N} .,:+&()\/-]/gu, " ").replace(/\s+/g, " ").trim();
function parseSpecs(chunks, byName) {
  const models = {};
  for (const c of chunks || []) {
    if (c?.category !== "specs" || typeof c.content !== "string") continue;
    const brand = brandOf(byName, c.brand);
    if (!brand || !c.model) continue;
    const key = brand + "|" + c.model;
    const head = String(c.title || "").split(" / ")[0].trim();
    const name = clean(head.toLowerCase().startsWith(brand.toLowerCase() + " ") ? head.slice(brand.length + 1) : head) || clean(c.model);
    const g = models[key] || (models[key] = { brand, model: name, trims: {} });
    if (!c.trim) {
      const m = c.content.match(/комплектации\s*\(\d+\)\s*:\s*([^\n]+?)\.?\s*(?:\n|$)/i);
      if (m) for (const t of m[1].split(/,\s+(?=[\p{Lu}\d])/u)) { const n = clean(t); if (n && !g.trims[n]) g.trims[n] = null; }
      continue;
    }
    const t = clean(c.trim), p = c.content.match(SPEC_PRICE);
    if (!(t in g.trims)) g.trims[t] = null;
    if (p) { const v = Number(p[1].replace(/[\s.,]/g, "")); if (v >= 1000 && v <= 1e7) g.trims[t] = v; }
  }
  const out = {};
  for (const g of Object.values(models)) {
    const first = g.model.split(" ")[0].toLowerCase();
    // Every model and trim in the base is offered; a trim without a price line is listed without a price.
    const trims = Object.entries(g.trims).map(([t, price]) => {
      const full = (t.toLowerCase().startsWith(first) ? t : `${g.model} ${t}`).slice(0, 80);
      return { name: full, year: null, price, pt: PT(g.model + " " + t) };
    }).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const pts = [...new Set([PT(g.model), ...trims.map(t => t.pt)].filter(Boolean))];
    (out[g.brand] || (out[g.brand] = [])).push({ model: g.model, pt: pts.length === 1 ? pts[0] : "", from: trims[0]?.price ?? null, trims });
  }
  for (const l of Object.values(out)) l.sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity) || a.model.localeCompare(b.model));
  return out;
}

// The price of a trim the customer picked, or null when it is not in stock.
function priceOf(stock, brand, name) {
  for (const g of stock?.[brand] || []) for (const t of g.trims) if (t.name === name) return t.price;
  return null;
}

module.exports = { parse, priceOf, modelOf };
