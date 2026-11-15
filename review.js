/* GameNest Plus: the game review (the owner, 2026-10-17, "yes" to ref/chess_looks/plus_review_puzzle.png).

   Every position of a finished game is searched (alpha-beta over chess.js's moves, captures searched on past the
   depth so a trade is never judged half-way, deeper and deeper until its time is up), and each move is judged by how
   much of the mover's chance of winning it gave away, as Lichess judges them:
     best (the engine's own) / excellent / good / inaccuracy / mistake / blunder,
   and "brilliant": the engine's own move that leaves a piece hanging, played when the game was not already won.
   Accuracy is Lichess's: 103.1668 e^(-0.04354 loss) - 3.1669 a move, averaged for each side.

   It is our own search, not Stockfish: strong enough to catch a hanging piece and a missed tactic, not to judge a
   grandmaster. A review runs in a worker thread (review_worker.js), so the rooms never wait on it. */
"use strict";
const { Chess, evaluate } = require("./game");

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const MATE = 100000;
const OutOfTime = Symbol("out of time");

function order(moves, first) {
  const score = (m) => (first && m.lan === first ? 1e6 : 0) + (m.captured ? VALUE[m.captured] * 10 - VALUE[m.piece] : 0) + (m.promotion ? 8000 : 0);
  return moves.sort((a, b) => score(b) - score(a));
}

/* The engine: one search a position, each with its own deadline and node count. */
class Engine {
  constructor(budgetMs = 250, maxDepth = 4) { this.budgetMs = budgetMs; this.maxDepth = maxDepth; }

  quiesce(chess, alpha, beta, sign) {
    this.tick();
    const stand = sign * evaluate(chess);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    for (const m of order(chess.moves({ verbose: true }).filter((x) => x.captured || x.promotion))) {
      chess.move(m);
      let v;
      try { v = -this.quiesce(chess, -beta, -alpha, -sign); } finally { chess.undo(); }
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  negamax(chess, depth, alpha, beta, sign, ply) {
    this.tick();
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) return chess.inCheck() ? -MATE + ply : 0;
    if (ply > 0 && (chess.isThreefoldRepetition() || chess.isInsufficientMaterial())) return 0;
    if (depth <= 0) return this.quiesce(chess, alpha, beta, sign);
    let best = -Infinity;
    for (const m of order(moves)) {
      chess.move(m);
      let v;
      try { v = -this.negamax(chess, depth - 1, -beta, -alpha, -sign, ply + 1); } finally { chess.undo(); }
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  tick() { if ((++this.nodes & 255) === 0 && Date.now() > this.deadline) throw OutOfTime; }

  /* The best move and its value for the side to move (centipawns, a mate as +-MATE less its distance). */
  search(chess) {
    const sign = chess.turn() === "w" ? 1 : -1;
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) return { move: null, score: chess.inCheck() ? -MATE : 0 };
    this.deadline = Date.now() + this.budgetMs;
    this.nodes = 0;
    let done = null;
    try {
      for (let d = 1; d <= this.maxDepth; d++) {
        let best = null, bestV = -Infinity, alpha = -Infinity;
        for (const m of order(moves.slice(), done && done.move.lan)) {
          chess.move(m);
          let v;
          try { v = -this.negamax(chess, d - 1, -Infinity, -alpha, -sign, 1); } finally { chess.undo(); }
          if (v > bestV) { bestV = v; best = m; }
          if (v > alpha) alpha = v;
        }
        done = { move: best, score: bestV, depth: d };
        if (Math.abs(bestV) > MATE - 100) break;   // a mate found needs no deeper look
      }
    } catch (e) {
      if (e !== OutOfTime) throw e;
    }
    if (!done) done = { move: order(moves)[0], score: sign * evaluate(chess), depth: 0 };
    return done;
  }
}

/* The mover's chance of winning from a score in centipawns (Lichess's curve). */
function winPct(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/* Whether the moved piece now stands where the other side can win material by taking it. */
function hangs(chess, move) {
  if (move.piece === "p" || move.piece === "k") return false;
  // The other side is to move: any capture on the square that wins two pawns' worth, the mover's guard counted.
  const mover = chess.turn() === "w" ? "b" : "w";
  const guarded = chess.isAttacked(move.to, mover);
  return chess.moves({ verbose: true }).some((m) => m.to === move.to && m.captured
    && VALUE[move.piece] - (guarded ? VALUE[m.piece] : 0) >= 200);
}

function grade(loss, isBest) {
  if (isBest && loss <= 2) return "best";
  if (loss <= 2) return "excellent";
  if (loss <= 5) return "good";
  if (loss <= 10) return "inaccuracy";
  if (loss <= 20) return "mistake";
  return "blunder";
}

/* One move judged: the search before it (here: the mover's best and its score) and after it (next: the other side's),
   into its ply and the mover's accuracy. */
function judge(chess, here, next, played, mover, uci, acc) {
  const before = here.score;                     // the mover's, with the best move
  const after = -next.score;                     // the mover's, after the move played
  const isBest = !!(here.move && here.move.lan === played.lan);
  const loss = Math.max(0, winPct(before) - winPct(isBest ? Math.max(after, before) : after));
  let cls = grade(loss, isBest);
  if (cls === "best" && winPct(before) < 85 && hangs(chess, played) && !chess.isCheckmate()) cls = "brilliant";
  acc[mover].push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)));
  // White's view; a mate as mate (moves to it, + for White) and eval held at +-10000.
  const white = mover === "w" ? after : -after;
  const mate = Math.abs(white) > MATE - 1000 ? Math.sign(white) * Math.max(1, Math.ceil((MATE - Math.abs(white)) / 2)) : null;
  return {
    san: played.san, uci, cls,
    best: here.move ? here.move.san : null, bestUci: here.move ? here.move.lan : null,
    eval: mate ? Math.sign(white) * 10000 : Math.round(white), mate,
  };
}

const mean = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
const play = (chess, uci) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

/* Reviews a game with our own search: its moves (uci, from the standard start or fen), with progress(i, n) after each
   position. Returns { plies: [{ san, uci, cls, best, bestUci, eval, mate }], accuracy: { w, b } }; eval is White's,
   centipawns, and mate the moves to a mate (+ for White) where there is one. */
function review(moves, { fen, budgetMs = 250, maxDepth = 4, progress } = {}) {
  const chess = fen ? new Chess(fen) : new Chess();
  const engine = new Engine(budgetMs, maxDepth);
  const plies = [];
  const acc = { w: [], b: [] };
  let here = engine.search(chess);
  for (let i = 0; i < moves.length; i++) {
    const mover = chess.turn();
    const played = play(chess, moves[i]);
    const next = engine.search(chess);
    plies.push(judge(chess, here, next, played, mover, moves[i], acc));
    here = next;
    if (progress) progress(i + 1, moves.length);
  }
  return { plies, accuracy: { w: mean(acc.w), b: mean(acc.b) } };
}

/* The same with any engine whose search(chess) answers a promise of { move: { lan, san } | null, score } (the side to
   move's, as Engine.search's). */
async function reviewWith(search, moves, { fen, progress } = {}) {
  const chess = fen ? new Chess(fen) : new Chess();
  const plies = [];
  const acc = { w: [], b: [] };
  let here = await search(chess);
  for (let i = 0; i < moves.length; i++) {
    const mover = chess.turn();
    const played = play(chess, moves[i]);
    const next = await search(chess);
    plies.push(judge(chess, here, next, played, mover, moves[i], acc));
    here = next;
    if (progress) progress(i + 1, moves.length);
  }
  return { plies, accuracy: { w: mean(acc.w), b: mean(acc.b) } };
}

module.exports = { review, reviewWith, winPct, grade, Engine, MATE };
