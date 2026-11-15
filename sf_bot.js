/* GameNest Plus's strong coaches (the owner, 2026-10-17: "add all of them"): Expert and Master, Stockfish (sf.js) in
   one long-lived worker thread, so a search never holds the rooms' thread. move(fen, { elo, movetimeMs }) answers a
   promise of the move ("e2e4") or null, if the worker is not there or is slow (the caller then plays the old way).
   Pacing round 1 (2026-11-01): a bot's move is served before an analysis queued ahead of it, and a worker that answers
   nothing to two bot moves running is replaced (a wedged engine cost every Expert and Master move its whole timeout). */
"use strict";
const path = require("path");
const { Worker, isMainThread, parentPort } = require("worker_threads");

if (isMainThread) {
  let worker = null, seq = 0, queued = 0, silent = 0;
  const waiting = new Map();
  function start() {
    if (worker) return worker;
    const Sf = require("./sf");
    if (!Sf.available()) return null;
    let w;
    try { w = new Worker(__filename); } catch (e) { console.error("sf_bot: the worker did not start:", (e && e.message) || e); return null; }
    worker = w;
    w.unref();   // it never keeps the server up on its own
    w.on("message", ({ id, uci, lines }) => { silent = 0; const e = waiting.get(id); if (e) { waiting.delete(id); e.f(lines || uci || null); } });
    // Only this worker's own waiters: a replaced worker's late exit must not answer the new one's.
    const lost = () => { if (worker === w) { worker = null; queued = 0; } dropWaiting(w); };
    w.on("error", (e) => { console.error("sf_bot: the worker failed:", (e && e.message) || e); lost(); });
    w.on("exit", lost);
    return w;
  }
  function dropWaiting(w) {
    for (const [id, e] of [...waiting]) if (e.w === w) { waiting.delete(id); e.f(null); }
  }
  function recycle() {
    const w = worker;
    if (!w) return;
    worker = null; silent = 0; queued = 0;
    dropWaiting(w);
    try { w.terminate(); } catch (e) { /* already gone */ }
  }
  function move(fen, { elo = null, movetimeMs = 600, timeoutMs = 2400 } = {}) {
    const w = start();
    if (!w) return Promise.resolve(null);
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!waiting.delete(id)) return;
        resolve(null);
        if (++silent >= 2) recycle();
      }, timeoutMs);
      waiting.set(id, { w, f: (uci) => { clearTimeout(t); resolve(uci); } });
      try { w.postMessage({ id, fen, elo, movetimeMs, kind: "move" }); } catch (e) { if (waiting.delete(id)) { clearTimeout(t); resolve(null); } }
    });
  }
  /* GameNest Plus's analysis board: Stockfish's best lines there (sf.js's analyse), or null if the worker is not
     there or is slow. */
  function analyse(fen, { lines = 3, movetimeMs = 700, timeoutMs = 5000 } = {}) {
    const w = start();
    if (!w) return Promise.resolve(null);
    const id = ++seq;
    // A queue on the one engine: shorter searches while it lasts (at least 200 ms), so nobody waits long for theirs.
    const ms = queued > 2 ? Math.max(200, Math.round(movetimeMs * 2 / queued)) : movetimeMs;
    queued += 1;
    return new Promise((resolve) => {
      const done = (r) => { queued = Math.max(0, queued - 1); resolve(r); };
      const t = setTimeout(() => { if (waiting.delete(id)) done(null); }, timeoutMs + queued * 400);
      waiting.set(id, { w, f: (r) => { clearTimeout(t); done(r); } });
      try { w.postMessage({ id, fen, kind: "analyse", lines, movetimeMs: ms }); } catch (e) { if (waiting.delete(id)) { clearTimeout(t); done(null); } }
    });
  }
  module.exports = { move, analyse };
} else {
  // The worker: one engine, the requests one after another.
  const Sf = require(path.join(__dirname, "sf"));
  const { Chess } = require(path.join(__dirname, "game"));
  let engine = null;
  /* A bot's move (high) is served before an analysis (low) that has not started. */
  const high = [], low = [];
  let pumping = false;
  async function serve(req) {
    try {
      if (!engine) engine = await Sf.open(req.movetimeMs);
      if (req.kind === "analyse") {
        const lines = await engine.analyse(new Chess(req.fen), { lines: req.lines, movetimeMs: req.movetimeMs });
        parentPort.postMessage({ id: req.id, lines });
        return;
      }
      const r = await engine.search(new Chess(req.fen), { elo: req.elo, movetimeMs: req.movetimeMs });
      parentPort.postMessage({ id: req.id, uci: r.move ? r.move.lan : null });
    } catch (e) {
      parentPort.postMessage({ id: req.id, uci: null });
    }
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try { for (let req; (req = high.shift() || low.shift());) await serve(req); } finally { pumping = false; }
  }
  parentPort.on("message", (req) => { (req.kind === "analyse" ? low : high).push(req); pump(); });
}
