/* GameNest Plus's counters (the owner, 2026-10-18: "go do all of them", "take it to max"): how many open the Plus page,
   tap Get Plus or the monthly, buy, start a trial, see a "comes with Plus" line, open the locker, pick a look. Counts a
   day, nothing else: no player id, no name, no device, no address kept. The app posts { event, game? } to
   <base>/plus-stats; <base>/plus-stats/summary reads the last 30 days back. Kept in plus_stats.json beside the server,
   written at most every few seconds. */
"use strict";
const fs = require("fs");
const path = require("path");

const EVENTS = Object.freeze([
  "page_open", "get_plus_tap", "monthly_tap", "purchase_ok", "purchase_failed", "restore_tap", "trial_shown", "trial_start",
  "upsell_shown", "upsell_tap", "locker_open", "look_pick", "tip_tap",
]);
const GAMES = /^[a-z]{2,12}$/;
const FILE = process.env.PLUS_STATS_FILE || path.join(__dirname, "plus_stats.json");
const KEEP_DAYS = 60;

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); return d && typeof d === "object" ? d : {}; } catch (e) { return {}; }
}
let days = load();
let dirty = false;
const day = (now = new Date()) => now.toISOString().slice(0, 10);

/* One event (and the game it came from, if any): true if counted. */
function count(event, game, now = new Date()) {
  if (!EVENTS.includes(event)) return false;
  const d = day(now);
  const today = days[d] || (days[d] = {});
  today[event] = (today[event] || 0) + 1;
  if (typeof game === "string" && GAMES.test(game)) {
    const key = `${event}:${game}`;
    today[key] = (today[key] || 0) + 1;
  }
  dirty = true;
  return true;
}

/* The last n days, newest first, and their totals. */
function summary(n = 30) {
  const keys = Object.keys(days).sort().reverse().slice(0, n);
  const totals = {};
  for (const k of keys) for (const [e, c] of Object.entries(days[k])) if (!e.includes(":")) totals[e] = (totals[e] || 0) + c;
  const rate = (a, b) => (totals[b] ? Math.round((1000 * (totals[a] || 0)) / totals[b]) / 10 : null);
  return { days: keys.map((k) => ({ day: k, ...days[k] })), totals, conversion: { buyPerPageOpen: rate("purchase_ok", "page_open"), tapPerPageOpen: rate("get_plus_tap", "page_open"), upsellTapPerShown: rate("upsell_tap", "upsell_shown") } };
}

function flush() {
  if (!dirty) return;
  dirty = false;
  const keys = Object.keys(days).sort();
  while (keys.length > KEEP_DAYS) delete days[keys.shift()];
  try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(days)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { dirty = true; }
}
const timer = setInterval(flush, 5000);
timer.unref();
process.on("exit", flush);

/* The two routes on an express app under base; a few events a second from one address at most. */
function mount(app, base, express) {
  const recent = new Map();
  app.post(`${base}/plus-stats`, express.json({ limit: "1kb" }), (req, res) => {
    const ip = req.ip || "";
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter((t) => now - t < 1000);
    if (hits.length >= 5) return res.status(429).json({ ok: false });
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 5000) recent.clear();
    const body = req.body || {};
    res.json({ ok: count(String(body.event || ""), body.game) });
  });
  app.get(`${base}/plus-stats/summary`, (req, res) => res.json(summary(Math.min(60, Math.max(1, Number(req.query.days) || 30)))));
}

module.exports = { EVENTS, count, summary, flush, mount, _reset: () => { days = {}; dirty = false; } };
