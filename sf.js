/* Stockfish for the game review (the owner, 2026-10-17: "allow stockfish"). engine/ holds Stockfish 19's lite,
   single-threaded WebAssembly build from the npm package stockfish@19.0.1 (GPL-3.0, engine/COPYING-stockfish.txt): it
   runs here on the server and is never sent to the app. It speaks UCI: a timed search a position, its last score and
   best move read back. Missing (an older checkout), review_worker.js falls back to review.js's own search. */
"use strict";
const fs = require("fs");
const path = require("path");
const { Chess } = require("./game");
const { MATE } = require("./review");

const FILE = path.join(__dirname, "engine", "stockfish-19-lite-single.js");

function available() {
  return fs.existsSync(FILE) && fs.existsSync(FILE.replace(/\.js$/, ".wasm"));
}

/* An engine, ready: its search(chess) answers { move: { lan, san } | null, score } for the side to move (centipawns;
   a mate in N as MATE less its plies, as review.js scores them). One search at a time. */
async function open(movetimeMs = 250) {
  const sf = require(FILE)();
  let onLine = null;
  sf.listener = (line) => { if (onLine) onLine(String(line)); };
  const until = (want) => new Promise((resolve) => {
    const seen = [];
    onLine = (line) => {
      seen.push(line);
      if (want(line)) { onLine = null; resolve(seen); }
    };
  });
  let ready = until((l) => l === "uciok");
  sf.processCommand("uci");
  await ready;
  ready = until((l) => l === "readyok");
  sf.processCommand("ucinewgame");
  sf.processCommand("isready");
  await ready;

  /* opts: elo (Stockfish held to that strength, 1320 to 3190; none for its full strength) and movetimeMs (this search's
     time, else the engine's). */
  let heldTo = null;
  async function search(chess, { elo = null, movetimeMs: ms = movetimeMs } = {}) {
    if (chess.moves().length === 0) return { move: null, score: chess.inCheck() ? -MATE : 0 };
    if (elo !== heldTo) {
      sf.processCommand("setoption name UCI_LimitStrength value " + (elo ? "true" : "false"));
      if (elo) sf.processCommand("setoption name UCI_Elo value " + Math.max(1320, Math.min(3190, Math.round(elo))));
      heldTo = elo;
    }
    const done = until((l) => l.startsWith("bestmove"));
    sf.processCommand("position fen " + chess.fen());
    sf.processCommand("go movetime " + Math.max(10, ms));
    const lines = await done;
    let score = 0;
    for (const l of lines) {
      const cp = / score cp (-?\d+)/.exec(l);
      const mate = / score mate (-?\d+)/.exec(l);
      if (cp) score = Number(cp[1]);
      else if (mate) { const n = Number(mate[1]); score = n > 0 ? MATE - (2 * n - 1) : -(MATE - 2 * Math.abs(n)); }
    }
    const best = (/^bestmove (\S+)/.exec(lines[lines.length - 1]) || [])[1];
    let move = null;
    if (best && best !== "(none)") {
      const copy = new Chess(chess.fen());
      const m = copy.move({ from: best.slice(0, 2), to: best.slice(2, 4), promotion: best[4] });
      if (m) move = { lan: m.lan, san: m.san };
    }
    return { move, score };
  }
  /* GameNest Plus's analysis board: the best `lines` moves at full strength, each { uci, san, score, pv } for the
     side to move (score as search's), best first, pv the line's first moves in SAN. */
  async function analyse(chess, { lines = 3, movetimeMs: ms = 700 } = {}) {
    if (chess.moves().length === 0) return [];
    if (heldTo !== null) { sf.processCommand("setoption name UCI_LimitStrength value false"); heldTo = null; }
    sf.processCommand("setoption name MultiPV value " + lines);
    const done = until((l) => l.startsWith("bestmove"));
    sf.processCommand("position fen " + chess.fen());
    sf.processCommand("go movetime " + Math.max(10, ms));
    const seen = await done;
    sf.processCommand("setoption name MultiPV value 1");
    const best = new Map();
    for (const l of seen) {
      const k = / multipv (\d+)/.exec(l);
      const pv = / pv (.+)$/.exec(l);
      if (!k || !pv) continue;
      const cp = / score cp (-?\d+)/.exec(l);
      const mate = / score mate (-?\d+)/.exec(l);
      let score = 0;
      if (cp) score = Number(cp[1]);
      else if (mate) { const n = Number(mate[1]); score = n > 0 ? MATE - (2 * n - 1) : -(MATE - 2 * Math.abs(n)); }
      best.set(Number(k[1]), { score, ucis: pv[1].trim().split(/\s+/) });
    }
    const out = [];
    for (const k of [...best.keys()].sort((a, b) => a - b)) {
      const { score, ucis } = best.get(k);
      const copy = new Chess(chess.fen());
      const sans = [];
      for (const u of ucis.slice(0, 6)) {
        let m = null;
        try { m = copy.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (e) { m = null; }
        if (!m) break;
        sans.push(m.san);
      }
      if (sans.length) out.push({ uci: ucis[0], san: sans[0], score, pv: sans });
    }
    return out;
  }

  // UCI's "quit" ends the whole process here (the engine calls exit): stop it and stop listening instead; a worker
  // using it exits once its answer is posted.
  return { search, analyse, quit: () => { onLine = null; sf.processCommand("stop"); } };
}

module.exports = { available, open };
