// Sadə yaddaşdaxili limit: bir konteyner üçün kifayətdir, xarici asılılıq tələb etmir.
function rateLimit({ windowMs, max, key = req => req.ip, message = "Çox sayda sorğu. Bir az sonra yenidən cəhd et." }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  const limiter = (req, res, next) => {
    const k = key(req), now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > max) {
      res.set("Retry-After", Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
  // Lets a handler give back a hit, e.g. after a successful staff login.
  limiter.forgive = req => { const h = hits.get(key(req)); if (h && h.n > 0) h.n--; };
  return limiter;
}
module.exports = { rateLimit };
