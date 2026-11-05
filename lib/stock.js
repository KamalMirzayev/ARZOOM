"use strict";
// Partner stock and prices (Group Motors knowledge base, GET {origin}/credit/kb/{token}).
// The base is free text for a chat bot; price lists are chunks with category "price" whose lines look like
//   • Seal 6 DM-i 128km Active (2026) — 38 300 AZN — note
// Each line is one trim on sale. The model is the name up to the first trim word (DM-i, EV, AWD, 120km, ...).

const LINE = /^\s*[•*-]\s*(.+?)\s*\((\d{4})\)\s*[—–-]\s*([\d\s.,]+)\s*AZN\b/i;
const TRIM_WORD = /^(DM-?i|DM-?p|DM|EV|PHEV|HEV|AWD|4WD|2WD|FWD|RWD|Advanced|Premium|Hybrid|\d+\s*km)$/i;
const PT = t => (/\bEV\b/i.test(t) ? "E" : /\bDM-?[ip]?\b|PHEV/i.test(t) ? "P" : /\bHEV\b|hybrid/i.test(t) ? "H" : "");

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
    const brand = byName[String(c.brand || "").toLowerCase()];
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
  return res;
}

// The price of a trim the customer picked, or null when it is not in stock.
function priceOf(stock, brand, name) {
  for (const g of stock?.[brand] || []) for (const t of g.trims) if (t.name === name) return t.price;
  return null;
}

module.exports = { parse, priceOf, modelOf };
