/* GameNest's anonymous stats, crash notes and player reports (finish-line items 5e and 6, 2026-10-24). Copied next to a
   room server (the chess server is the one the app posts to) like reactions.js and plus_stats.js:
       require("./gn_stats").mount(app, BASE, express);
   Routes under <base>/stats (base is /chess on the chess server):
       POST events   { id, v, p, events: [{ e, g?, t, w?, s?, n? }] }   the app's batches
       POST crash    { id, v, p, os, device?, crumbs[], log, t }          the launch after a crash
       POST report   { game, room, name, reason, t }                      a player's report of another player
       GET  summary                                                        counts only: installs, DAU, D1/D7, plays per game
       GET  crashes, reports                                               the notes themselves; need STATS_KEY (or the server's own machine)
   What is kept: an install id the app made up (32 hex digits, nothing to do with a device or a person), the days it was
   seen, daily counters per event and per game, crash notes and reports. The connection's address is used to slow a flood
   and is never written down. Files live in STATS_DIR (default ~/Library/GameNest/Data/stats), outside the deploy clone. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const EVENTS = Object.freeze(["app_open", "game_start", "game_end", "quick_play", "mission_claim", "shop_buy", "streak_claim", "level_up"]);
const GAME = /^[a-z]{2,12}$/;
const ID = /^[0-9a-f]{32}$/;
const DAY_MS = 86400000;
const KEEP_DAYS = 400;
const MAX_INSTALLS = 500000;
const MAX_EVENTS_PER_POST = 60;
const MAX_NOTE_LINES = 5000;

const DIR = process.env.STATS_DIR || path.join(os.homedir(), "Library", "GameNest", "Data", "stats");
const FILE = () => path.join(DIR, "stats.json");

let state = { days: {}, installs: {} };   // days[YYYY-MM-DD] = { events, games, active, newInstalls }; installs[id] = { f: first day number, d: [day offsets seen] }
let dirty = false;

const dayNumber = (ms) => Math.floor(ms / DAY_MS);
const dayString = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (d && typeof d === "object" && d.days && d.installs) state = d;
  } catch (e) { /* first run */ }
}
load();

function dayBucket(n) {
  const k = dayString(n);
  return state.days[k] || (state.days[k] = { events: {}, games: {}, active: 0, newInstalls: 0 });
}

/* The day an event belongs to: its own time when the phone's clock is believable (queued events arrive late), else now. */
function eventDay(t, now) {
  const ms = Number(t) * 1000;
  if (Number.isFinite(ms) && ms > now - 8 * DAY_MS && ms < now + DAY_MS) return dayNumber(ms);
  return dayNumber(now);
}

/* One batch from one install: true if it was taken. */
function ingest(body, now = Date.now()) {
  if (!body || typeof body !== "object" || !ID.test(String(body.id || "")) || !Array.isArray(body.events)) return false;
  const id = body.id;
  const rec = state.installs[id];
  const isNew = !rec;
  if (isNew && Object.keys(state.installs).length >= MAX_INSTALLS) return false;
  const todayN = dayNumber(now);
  let inst = rec;
  const touch = (n) => {
    if (!inst) { inst = state.installs[id] = { f: n, d: [0] }; dayBucket(n).newInstalls++; dayBucket(n).active++; return; }
    if (n < inst.f) {   // an older queued event: the first day moves back, offsets shift
      const shift = inst.f - n;
      inst.d = inst.d.map((o) => o + shift);
      inst.d.push(0);
      inst.f = n;
      dayBucket(n).active++;
      return;
    }
    const off = n - inst.f;
    if (!inst.d.includes(off) && off <= 60) { inst.d.push(off); dayBucket(n).active++; }
  };
  let taken = 0;
  for (const ev of body.events.slice(0, MAX_EVENTS_PER_POST)) {
    if (!ev || typeof ev !== "object" || !EVENTS.includes(ev.e)) continue;
    const n = eventDay(ev.t, now);
    touch(n);
    const b = dayBucket(n);
    b.events[ev.e] = (b.events[ev.e] || 0) + 1;
    if (typeof ev.g === "string" && GAME.test(ev.g)) {
      const g = b.games[ev.g] || (b.games[ev.g] = { start: 0, end: 0, wins: 0, seconds: 0, quick: 0 });
      if (ev.e === "game_start") g.start++;
      else if (ev.e === "quick_play") g.quick++;
      else if (ev.e === "game_end") {
        g.end++;
        if (ev.w === 1) g.wins++;
        const s = Number(ev.s);
        if (Number.isFinite(s) && s >= 0 && s <= 6 * 3600) g.seconds += s;
      }
    }
    taken++;
  }
  if (taken) dirty = true;
  void todayN;
  return taken > 0;
}

function summary(days = 30, now = Date.now()) {
  const today = dayNumber(now);
  const keys = Object.keys(state.days).sort().reverse().slice(0, days);
  const totals = {};
  const games = {};
  for (const k of keys) {
    const b = state.days[k];
    for (const [e, c] of Object.entries(b.events)) totals[e] = (totals[e] || 0) + c;
    for (const [g, v] of Object.entries(b.games)) {
      const a = games[g] || (games[g] = { start: 0, end: 0, wins: 0, seconds: 0, quick: 0 });
      for (const f of Object.keys(a)) a[f] += v[f] || 0;
    }
  }
  const perGame = Object.entries(games).map(([game, v]) => ({
    game, started: v.start, finished: v.end, quickPlays: v.quick,
    winRate: v.end ? Math.round((1000 * v.wins) / v.end) / 10 : null,
    avgSeconds: v.end ? Math.round(v.seconds / v.end) : null,
  })).sort((a, b) => b.finished - a.finished);
  // Retention: of the installs first seen on a day, how many were seen again exactly 1 (7) days later.
  const cohorts = {};
  for (const inst of Object.values(state.installs)) {
    const c = cohorts[inst.f] || (cohorts[inst.f] = { size: 0, d1: 0, d7: 0 });
    c.size++;
    if (inst.d.includes(1)) c.d1++;
    if (inst.d.includes(7)) c.d7++;
  }
  const rate = (field, minAge) => {
    let size = 0, kept = 0;
    for (const [f, c] of Object.entries(cohorts)) if (today - Number(f) >= minAge) { size += c.size; kept += c[field]; }
    return { cohortSize: size, retained: kept, rate: size ? Math.round((1000 * kept) / size) / 10 : null };
  };
  return {
    installs: Object.keys(state.installs).length,
    days: keys.map((k) => ({ day: k, active: state.days[k].active, newInstalls: state.days[k].newInstalls, events: state.days[k].events })),
    totals,
    perGame,
    retention: { d1: rate("d1", 1), d7: rate("d7", 7) },
  };
}

function flush() {
  if (!dirty) return;
  dirty = false;
  const keys = Object.keys(state.days).sort();
  while (keys.length > KEEP_DAYS) delete state.days[keys.shift()];
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE() + ".tmp", JSON.stringify(state));
    fs.renameSync(FILE() + ".tmp", FILE());
  } catch (e) { dirty = true; }
}
const timer = setInterval(flush, 5000);
timer.unref();
process.on("exit", flush);

/* Notes (crashes, reports) are one JSON line each, trimmed to the last MAX_NOTE_LINES. */
function appendNote(name, obj) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, name);
    fs.appendFileSync(file, JSON.stringify(obj) + "\n");
    const st = fs.statSync(file);
    if (st.size > 4 * 1024 * 1024) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      fs.writeFileSync(file, lines.slice(-MAX_NOTE_LINES).join("\n") + "\n");
    }
  } catch (e) { console.error("stats note not written:", e.message); }
}
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

function crashNote(b, now = Date.now()) {
  if (!b || typeof b !== "object" || !ID.test(String(b.id || ""))) return null;
  return {
    at: new Date(now).toISOString(), id: b.id, v: clip(b.v, 20), p: clip(b.p, 12), os: clip(b.os, 40), device: clip(b.device, 40),
    crumbs: Array.isArray(b.crumbs) ? b.crumbs.slice(-20).map((c) => clip(c, 40)) : [], log: clip(b.log, 4000),
  };
}

function reportNote(b, now = Date.now()) {
  if (!b || typeof b !== "object" || !String(b.name || "").trim()) return null;
  return { at: new Date(now).toISOString(), game: clip(b.game, 12), room: clip(b.room, 12), name: clip(b.name, 40), reason: clip(b.reason, 60) };
}

function readNotes(name, n) {
  try { return fs.readFileSync(path.join(DIR, name), "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch (e) { return []; }
}

function mount(app, base, express) {
  const recent = new Map();
  const limited = (req, perMinute) => {
    const ip = req.ip || "";
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= perMinute) return true;
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 5000) recent.clear();
    return false;
  };
  const allowed = (req) => {
    const key = process.env.STATS_KEY || "";
    if (key) return req.query.key === key || req.get("x-stats-key") === key;
    const ip = req.ip || "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  };
  app.post(`${base}/stats/events`, express.json({ limit: "24kb" }), (req, res) => {
    if (limited(req, 30)) return res.status(429).json({ ok: false });
    res.json({ ok: ingest(req.body) });
  });
  app.post(`${base}/stats/crash`, express.json({ limit: "16kb" }), (req, res) => {
    if (limited(req, 6)) return res.status(429).json({ ok: false });
    const note = crashNote(req.body);
    if (note) appendNote("crashes.jsonl", note);
    res.json({ ok: !!note });
  });
  app.post(`${base}/stats/report`, express.json({ limit: "2kb" }), (req, res) => {
    if (limited(req, 10)) return res.status(429).json({ ok: false });
    const note = reportNote(req.body);
    if (note) {
      appendNote("reports.jsonl", note);
      console.log(`[report] ${note.game} ${note.room} "${note.name}": ${note.reason}`);
    }
    res.json({ ok: !!note });
  });
  app.get(`${base}/stats/summary`, (req, res) => {
    if (process.env.STATS_KEY && !allowed(req)) return res.status(403).json({ ok: false });
    const out = summary(Math.min(120, Math.max(1, Number(req.query.days) || 30)));
    out.crashes = readNotes("crashes.jsonl", MAX_NOTE_LINES).length;
    out.reports = readNotes("reports.jsonl", MAX_NOTE_LINES).length;
    res.json(out);
  });
  app.get(`${base}/stats/crashes`, (req, res) => (allowed(req) ? res.json(readNotes("crashes.jsonl", 100)) : res.status(403).json({ ok: false })));
  app.get(`${base}/stats/reports`, (req, res) => (allowed(req) ? res.json(readNotes("reports.jsonl", 200)) : res.status(403).json({ ok: false })));
}

module.exports = { EVENTS, ingest, summary, flush, mount, crashNote, reportNote, _reset: () => { state = { days: {}, installs: {} }; dirty = false; } };
