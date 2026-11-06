const express = require("express");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");
const path = require("path");

const app = express();
const db = new Database(path.join(__dirname, "urls.db"));

// Behind a hosting proxy (Render, Heroku, etc.) this makes req.ip the real
// client IP and req.protocol "https", instead of the proxy's values.
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    code TEXT PRIMARY KEY,
    original TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    clicked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (code) REFERENCES urls(code)
  );
  CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(code);
`);

// --- LRU cache for hot links (Map keeps insertion order) ---
const CACHE_LIMIT = 1000;
const cache = new Map();
function cacheGet(code) {
  if (!cache.has(code)) return null;
  const val = cache.get(code);
  cache.delete(code); cache.set(code, val);
  return val;
}
function cacheSet(code, url) {
  cache.set(code, url);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

// --- Per-IP token-bucket rate limiter ---
const buckets = new Map();
const RATE = 10, PER_MS = 60_000;
function rateLimit(req, res, next) {
  const now = Date.now();
  const b = buckets.get(req.ip) || { tokens: RATE, last: now };
  b.tokens = Math.min(RATE, b.tokens + ((now - b.last) / PER_MS) * RATE);
  b.last = now;
  buckets.set(req.ip, b);
  if (b.tokens < 1) return res.status(429).json({ error: "Too many requests" });
  b.tokens -= 1;
  next();
}
// Drop idle buckets (any bucket idle for PER_MS is full again) so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.last > PER_MS) buckets.delete(ip);
}, PER_MS).unref();

const isValidUrl = (s) => {
  try { const u = new URL(s); return ["http:", "https:"].includes(u.protocol); }
  catch { return false; }
};

const insertUrl = db.prepare("INSERT INTO urls (code, original) VALUES (?, ?)");
const findUrl = db.prepare("SELECT * FROM urls WHERE code = ?");
const insertClick = db.prepare("INSERT INTO clicks (code, referrer, user_agent) VALUES (?, ?, ?)");
const countClicks = db.prepare("SELECT COUNT(*) c FROM clicks WHERE code = ?");
const dailyClicks = db.prepare(`
  SELECT DATE(clicked_at) day, COUNT(*) clicks FROM clicks
  WHERE code = ? GROUP BY day ORDER BY day DESC LIMIT 7`);
const topReferrers = db.prepare(`
  SELECT COALESCE(referrer, 'direct') referrer, COUNT(*) clicks FROM clicks
  WHERE code = ? GROUP BY referrer ORDER BY clicks DESC LIMIT 5`);

app.post("/api/shorten", rateLimit, (req, res) => {
  const { url, alias } = req.body || {};
  if (typeof url !== "string" || !isValidUrl(url))
    return res.status(400).json({ error: "Invalid URL" });
  if (alias !== undefined && (typeof alias !== "string" || !/^[a-zA-Z0-9_-]{3,20}$/.test(alias)))
    return res.status(400).json({ error: "Alias must be 3-20 chars (letters, digits, _ or -)" });
  const code = alias || nanoid(7);
  try {
    insertUrl.run(code, url);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
      return res.status(409).json({ error: "Alias already taken" });
    throw err;
  }
  res.status(201).json({ code, short: `${req.protocol}://${req.get("host")}/${code}` });
});

app.get("/api/stats/:code", (req, res) => {
  const url = findUrl.get(req.params.code);
  if (!url) return res.status(404).json({ error: "Not found" });
  res.json({
    ...url,
    totalClicks: countClicks.get(url.code).c,
    daily: dailyClicks.all(url.code),
    referrers: topReferrers.all(url.code),
  });
});

app.get("/:code", (req, res) => {
  const { code } = req.params;
  let original = cacheGet(code);
  if (!original) {
    const row = findUrl.get(code);
    if (!row) return res.status(404).send("Link not found");
    original = row.original;
    cacheSet(code, original);
  }
  insertClick.run(code, req.get("referer") || null, req.get("user-agent") || null);
  res.redirect(302, original);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
