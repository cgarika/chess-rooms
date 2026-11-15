/* The free bots as people (2026-10-18, Hugging Face): Easy, Normal and Hard play Maia-2's moves, the move a human of
   that rating is likeliest to make (CSSLab's Maia-2, MIT; github.com/CSSLab/maia2), not a weakened engine's. The model
   is Maia-2 "rapid" in ONNX (tools/maia_model.sh makes it; 85 MB, kept out of git) at engine/maia2_rapid.onnx, the cache, or
   $MAIA_MODEL; engine/maia2_moves.json is its move list. It runs in one worker thread, so a move never holds the rooms'
   thread. move(chess, { elo, temp }) answers a promise of the move ("e2e4") or null, if the model is not there or is slow
   (the caller then plays the old way). Pacing round 1 (2026-11-01): a bot's request jumps ahead of a game review's in the
   worker (the review gives way between plies), a request that is not answered in time is null, never a throw, and a worker
   that answers nothing twice running is replaced; warm() loads the model before the first game needs it. */
"use strict";
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort } = require("worker_threads");

// The model: $MAIA_MODEL, else engine/'s, else the copy tools/maia_model.sh keeps in the Mac's GameNest cache (so a deploy
// clone made from git finds it too).
const MODEL = process.env.MAIA_MODEL || [path.join(__dirname, "engine", "maia2_rapid.onnx"),
  path.join(require("os").homedir(), "Library", "GameNest", "Cache", "maia2", "maia2_rapid.onnx")].find((f) => fs.existsSync(f))
  || path.join(__dirname, "engine", "maia2_rapid.onnx");
const MOVES = path.join(__dirname, "engine", "maia2_moves.json");
// onnxruntime-node: the server's own, else the one copy the Mac keeps for every server (moderation.js's too).
const SHARED_ORT = path.join(require("os").homedir(), "Library", "GameNest", "Cache", "ort", "node_modules", "onnxruntime-node");
function ortPath() {
  try { return require.resolve("onnxruntime-node"); } catch (e) { /* not the server's own */ }
  try { return require.resolve(SHARED_ORT); } catch (e) { return null; }
}

/* Maia-2's ratings come in bands: under 1100, a band each 100 to 2000, and 2000 up. */
function eloBand(elo) {
  if (elo < 1100) return 0;
  if (elo >= 2000) return 10;
  return Math.floor((elo - 1100) / 100) + 1;
}

const mirrorSq = (sq) => sq[0] + (9 - Number(sq[1]));
const mirrorMove = (uci) => mirrorSq(uci.slice(0, 2)) + mirrorSq(uci.slice(2, 4)) + uci.slice(4);

/* The position as Maia-2 sees it: always White to move (Black's positions are flipped top to bottom with the colours
   swapped, as python-chess's mirror() does); 18 planes of 8x8, rank 1 first: White's P N B R Q K, Black's, the side to
   move, the four castling rights (White's K Q, Black's), the en passant square. */
function encode(fen) {
  const [place, turn, castling, ep] = fen.split(" ");
  const black = turn === "b";
  const x = new Float32Array(18 * 64);
  const kinds = "pnbrqk";
  place.split("/").forEach((row, i) => {
    let rank = 7 - i, file = 0;
    if (black) rank = 7 - rank;
    for (const c of row) {
      if (c >= "1" && c <= "8") { file += Number(c); continue; }
      const white = c === c.toUpperCase();
      const mine = white !== black;   // the mover's pieces are "White's" here
      x[(kinds.indexOf(c.toLowerCase()) + (mine ? 0 : 6)) * 64 + rank * 8 + file] = 1;
      file += 1;
    }
  });
  const rights = black ? ["k", "q", "K", "Q"] : ["K", "Q", "k", "q"];
  const fill = (ch) => x.fill(1, ch * 64, ch * 64 + 64);
  fill(12);
  rights.forEach((r, i) => { if (castling.includes(r)) fill(13 + i); });
  if (ep && ep !== "-") {
    const sq = black ? mirrorSq(ep) : ep;
    x[17 * 64 + (Number(sq[1]) - 1) * 8 + (sq.charCodeAt(0) - 97)] = 1;
  }
  return { x, black };
}

/* A move from Maia-2's chances over the legal moves: below 2% never; temp 0 is always its first choice, 1 its odds as
   they are, between them its favourites more often. */
function pick(probs, temp, rand = Math.random) {
  const best = probs.reduce((a, b) => (b.p > a.p ? b : a));
  if (!temp) return best.uci;
  const keep = probs.filter((m) => m.p >= 0.02);
  const w = keep.map((m) => Math.pow(m.p, 1 / temp));
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < keep.length; i++) if ((r -= w[i]) <= 0) return keep[i].uci;
  return best.uci;
}

/* The rating each band of Maia-2 stands for: under 1100 as 1000, the 100-wide bands by their middles, 2000 up as 2100. */
const BAND_ELO = [1000, 1150, 1250, 1350, 1450, 1550, 1650, 1750, 1850, 1950, 2100];
const RATE_MIN_MOVES = 8;

/* A side's rating from how likely each band of Maia-2 finds its moves: the bands weighed by the chance they played
   them all (an even start), as a rating; null under RATE_MIN_MOVES moves that had a choice. logp: per move, the 11
   bands' log chances of the move played. */
function ratingOf(logp) {
  if (logp.length < RATE_MIN_MOVES) return null;
  const sum = BAND_ELO.map((_, b) => logp.reduce((a, l) => a + l[b], 0));
  const top = Math.max(...sum);
  const w = sum.map((v) => Math.exp(v - top));
  const tot = w.reduce((a, b) => a + b, 0);
  const elo = BAND_ELO.reduce((a, e, b) => a + e * w[b], 0) / tot;
  const band = sum.indexOf(top);
  return { elo: Math.round(elo / 50) * 50, low: band === 0, high: band === BAND_ELO.length - 1, moves: logp.length };
}

function available() {
  return fs.existsSync(MODEL) && fs.existsSync(MOVES);
}

if (isMainThread) {
  let worker = null, seq = 0, silent = 0;
  const waiting = new Map();
  function start() {
    if (worker) return worker;
    if (!available()) return null;
    if (!ortPath()) return null;
    let w;
    try { w = new Worker(__filename); } catch (e) { console.error("maia: the worker did not start:", (e && e.message) || e); return null; }
    worker = w;
    w.unref();   // it never keeps the server up on its own
    w.on("message", ({ id, result }) => { silent = 0; const e = waiting.get(id); if (e) { waiting.delete(id); e.f(result); } });
    // Whoever is waiting on this worker gets null (a bot then plays the old way); the next ask starts a fresh one. Only
    // this worker's own waiters: a replaced worker's late exit must not answer the new one's.
    const lost = () => { if (worker === w) worker = null; dropWaiting(w); };
    w.on("error", (e) => { console.error("maia: the worker failed:", (e && e.message) || e); lost(); });
    w.on("exit", lost);
    return w;
  }
  /* A worker that answered nothing to two requests running (a wedged model run) is thrown away: the next request starts
     a new one, so a hang costs two timeouts and not every move for ever. */
  function dropWaiting(w) {
    for (const [id, e] of [...waiting]) if (e.w === w) { waiting.delete(id); e.f(null); }
  }
  function recycle() {
    const w = worker;
    if (!w) return;
    worker = null; silent = 0;
    dropWaiting(w);
    try { w.terminate(); } catch (e) { /* already gone */ }
  }
  /* Maia-2's chances for each legal move ([{ uci, p }], likeliest first), or null. legal: the position's moves in UCI. */
  function ask(req, timeoutMs) {
    const w = start();
    if (!w) return Promise.resolve(null);
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!waiting.delete(id)) return;
        resolve(null);
        if (req.kind === "chances" && ++silent >= 2) recycle();
      }, timeoutMs);
      waiting.set(id, { w, f: (result) => { clearTimeout(t); resolve(result); } });
      try { w.postMessage({ id, ...req }); } catch (e) { if (waiting.delete(id)) { clearTimeout(t); resolve(null); } }
    });
  }
  function chances(fen, legal, { elo = 1500, oppoElo = elo, timeoutMs = 4000 } = {}) {
    return legal.length ? ask({ kind: "chances", fen, legal, elo, oppoElo }, timeoutMs) : Promise.resolve(null);
  }
  /* The game review's ratings (2026-10-18): how each side played, as a rating ({ w, b }: each { elo, low, high,
     moves } or null), from the game's moves in UCI; or null. low/high: under 1100 or 2000 up, Maia-2's ends. */
  function rate(moves, { fen, timeoutMs = 30000 } = {}) {
    const { Chess } = require("./game");
    const c = new Chess(fen);
    const plies = [];
    for (const uci of moves) {
      const legal = c.moves({ verbose: true }).map((m) => m.lan);
      if (legal.length > 1) plies.push({ fen: c.fen(), legal, played: uci, side: c.turn() });
      if (!c.move(uci)) break;
    }
    return plies.length ? ask({ kind: "rate", plies }, timeoutMs) : Promise.resolve(null);
  }
  /* The legal moves a bot keeps clear of: one that brings back a position the game has had, or takes its own last move
     straight back (no capture). Maia-2 sees one position, not the game, and in a quiet one often likes a piece back
     where it was: e3 Nf6 Be2, and it plays Ng8 78% of the time; shuffled so, a bot's game was a draw in 8 plies. */
  function repeating(chess) {
    const { Chess } = require("./game");
    const key = (c) => c.fen().split(" ").slice(0, 4).join(" ");
    try {
      const past = chess.history({ verbose: true });
      const c = new Chess(past.length ? past[0].before : chess.fen());
      const seen = new Set([key(c)]);
      for (const m of past) { c.move(m.lan); seen.add(key(c)); }
      const mine = past.length >= 2 ? past[past.length - 2] : null;
      const out = [];
      for (const m of chess.moves({ verbose: true })) {
        const back = mine && m.from === mine.to && m.to === mine.from && !m.captured;
        c.move(m.lan);
        if (back || seen.has(key(c))) out.push(m.lan);
        c.undo();
      }
      return out;
    } catch (e) {
      // A history that will not replay (a bad move in it) must not cost the bot its move: it plays without the repeat rule.
      return [];
    }
  }
  /* A move for a bot: chess, the game (chess.js); never one of repeating()'s, unless every move is. null, never a throw,
     when the model is not there, is slow (timeoutMs, 2.2 s for a bot) or fails. */
  const BOT_ASK_MS = 2200;
  async function move(chess, { elo = 1500, temp = 0.6, timeoutMs = BOT_ASK_MS } = {}) {
    try {
      const legal = chess.moves({ verbose: true }).map((m) => m.lan);
      const probs = await chances(chess.fen(), legal, { elo, timeoutMs });
      if (!probs || !probs.length) return null;
      const rep = new Set(repeating(chess));
      const fresh = probs.filter((m) => !rep.has(m.uci));
      if (!fresh.length) return pick(probs, temp);
      const tot = fresh.reduce((a, m) => a + m.p, 0);
      return pick(fresh.map((m) => ({ uci: m.uci, p: m.p / tot })), temp);
    } catch (e) {
      console.error("maia: a bot move failed:", (e && e.message) || e);
      return null;
    }
  }
  /* The model loaded before the first game asks for it (the first move of a fresh server otherwise waits for the session). */
  function warm() {
    if (!available() || !ortPath()) return Promise.resolve(false);
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    return chances(start, ["e2e4", "d2d4", "g1f3"], { elo: 1500, timeoutMs: 15000 }).then((r) => !!r, () => false);
  }
  module.exports = { _ask: ask, _alive: () => !!worker, move, chances, rate, repeating, available, warm, encode, eloBand, pick, mirrorMove, ratingOf, BAND_ELO };
} else {
  // The worker: one session, the requests one after another.
  const ort = require(ortPath());
  const index = new Map(JSON.parse(fs.readFileSync(MOVES, "utf8")).map((m, i) => [m, i]));
  let session = null;
  /* Per batch row, the log chance of each legal move (in Maia-2's frame, where Black's moves are flipped). */
  async function logChances(fen, legal, selfBands, oppoBands) {
    const { x, black } = encode(fen);
    const n = selfBands.length;
    const boards = new Float32Array(n * x.length);
    for (let k = 0; k < n; k++) boards.set(x, k * x.length);
    const out = await session.run({
      boards: new ort.Tensor("float32", boards, [n, 18, 8, 8]),
      elo_self: new ort.Tensor("int64", BigInt64Array.from(selfBands.map(BigInt)), [n]),
      elo_oppo: new ort.Tensor("int64", BigInt64Array.from(oppoBands.map(BigInt)), [n]),
    });
    const logits = out.logits_move.data, width = logits.length / n;
    const rows = legal.map((uci) => ({ uci, i: index.get(black ? mirrorMove(uci) : uci) })).filter((m) => m.i !== undefined);
    return selfBands.map((_, k) => {
      const at = (m) => logits[k * width + m.i];
      const top = Math.max(...rows.map(at));
      const lse = top + Math.log(rows.reduce((a, m) => a + Math.exp(at(m) - top), 0));
      return new Map(rows.map((m) => [m.uci, at(m) - lse]));
    });
  }
  const BANDS = BAND_ELO.map((_, b) => b);
  /* A bot's move waits for nobody: its request (high) is served before a game review's (low), and a review gives way to
     the bots between its plies, so a review never holds a bot's move for more than one ply's run. */
  const high = [], low = [];
  const post = (id, result) => parentPort.postMessage({ id, result });
  async function chancesFor(req) {
    if (req.stall) await new Promise(() => {});   // the tests' wedged model run (maia.js's _ask)
    const [row] = await logChances(req.fen, req.legal, [eloBand(req.elo)], [eloBand(req.oppoElo)]);
    return [...row].map(([uci, l]) => ({ uci, p: Math.exp(l) })).sort((a, b) => b.p - a.p);
  }
  async function serveHigh() {
    while (high.length) {
      const req = high.shift();
      try { post(req.id, await chancesFor(req)); } catch (e) { post(req.id, null); }
    }
  }
  async function rateFor(req) {
    // Each band against its like: the game's two sides are taken to be near each other's level.
    const logp = { w: [], b: [] };
    for (const ply of req.plies) {
      await serveHigh();
      const rows = await logChances(ply.fen, ply.legal, BANDS, BANDS);
      if (rows[0].has(ply.played)) logp[ply.side].push(rows.map((r) => r.get(ply.played)));
    }
    return { w: ratingOf(logp.w), b: ratingOf(logp.b) };
  }
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        await serveHigh();
        const req = low.shift();
        if (!req) { if (high.length) continue; break; }
        try { post(req.id, await rateFor(req)); } catch (e) { post(req.id, null); }
      }
    } finally { pumping = false; }
  }
  // One session, however many requests arrive while it loads; a load that failed is tried again by the next request.
  let loading = null;
  const ready = () => session ? Promise.resolve(session) : (loading = loading || ort.InferenceSession.create(MODEL).then((x) => (session = x), (e) => { loading = null; throw e; }));
  parentPort.on("message", (req) => {
    ready().then(() => {
      (req.kind === "rate" ? low : high).push(req);
      pump();
    }, () => post(req.id, null));
  });
}
