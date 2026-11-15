/* Chess for GameNest: the rules are chess.js's (castling, en passant, promotion, check, mate,
   stalemate, threefold repetition, the fifty-move rule, insufficient material); this adds what
   the room sends the app, and a bot. */
const { Chess } = require("chess.js");

/* The board as the app draws it: rank 1 first, file a first; "" empty, else colour and piece ("wK"). */
function boardOf(chess) {
  const rows = chess.board().slice().reverse();   // chess.js gives rank 8 first
  return rows.map((rank) => rank.map((sq) => (sq ? sq.color + sq.type.toUpperCase() : "")));
}

/* Every legal move for the side to move, as "e2e4" (and "e7e8q" for a promotion). */
function legalMoves(chess) {
  return chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
}

/* Why a finished game ended, and who won it ("w", "b" or null for a draw). */
function outcome(chess) {
  if (chess.isCheckmate()) return { reason: "checkmate", winner: chess.turn() === "w" ? "b" : "w" };
  if (chess.isStalemate()) return { reason: "stalemate", winner: null };
  if (chess.isThreefoldRepetition()) return { reason: "repetition", winner: null };
  if (chess.isInsufficientMaterial()) return { reason: "material", winner: null };
  if (chess.isDraw()) return { reason: "fifty", winner: null };
  return null;
}

/* ---------- the bot ----------
   Negamax with alpha-beta over chess.js's moves: material, and where each piece stands (a small
   table a piece, the usual "knights to the middle, pawns forward"); captures and promotions are
   tried first. Depth 3 by default, a beat on a phone's turn; among equal moves it picks at random. */
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, -20, -20, 10, 10, 5, 5, -5, -10, 0, 0, -10, -5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, 5, 10, 25, 25, 10, 5, 5, 10, 10, 20, 30, 30, 20, 10, 10, 50, 50, 50, 50, 50, 50, 50, 50, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 5, 5, 0, -20, -40, -30, 5, 10, 15, 15, 10, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 10, 15, 15, 10, 0, -30, -40, -20, 0, 0, 0, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 5, 0, 0, 0, 0, 5, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 5, 5, 0, 0, 0, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 5, 10, 10, 10, 10, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 5, 0, 0, 0, 0, -10, -10, 5, 5, 5, 5, 5, 0, -10, 0, 0, 5, 5, 5, 5, 0, -5, -5, 0, 5, 5, 5, 5, 0, -5, -10, 0, 5, 5, 5, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [20, 30, 10, 0, 0, 10, 30, 20, 20, 20, 0, 0, 0, 0, 20, 20, -10, -20, -20, -20, -20, -20, -20, -10, -20, -30, -30, -40, -40, -30, -30, -20, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30],
};
/* From white's side: the tables run rank 1 to rank 8; black's squares are mirrored. In an endgame
   the side ahead also wants the other king driven to the edge and its own king close (the
   "mop-up"): without it a bot a rook up shuffled for hundreds of moves before it found the mate. */
function evaluate(chess) {
  let score = 0, heavy = 0;
  const kings = {};
  const rows = chess.board();   // rank 8 first
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = rows[r][f];
    if (!sq) continue;
    const rank = 7 - r;
    if (sq.type === "k") kings[sq.color] = [f, rank];
    else if (sq.type !== "p") heavy += VALUE[sq.type];
    const idx = sq.color === "w" ? rank * 8 + f : (7 - rank) * 8 + f;
    const v = VALUE[sq.type] + PST[sq.type][idx];
    score += sq.color === "w" ? v : -v;
  }
  if (heavy <= 1800 && kings.w && kings.b && Math.abs(score) > 250) {
    const strong = score > 0 ? "w" : "b", weak = strong === "w" ? "b" : "w";
    const [wf, wr] = kings[weak], [sf, sr] = kings[strong];
    const edge = Math.max(3 - wf, wf - 4) + Math.max(3 - wr, wr - 4);   // 0 in the middle, 6 in a corner
    const near = 14 - (Math.abs(wf - sf) + Math.abs(wr - sr));
    const mop = 12 * edge + 5 * near;
    score += strong === "w" ? mop : -mop;
  }
  return score;
}
function ordered(chess) {
  return chess.moves({ verbose: true }).sort((a, b) => ((b.captured ? VALUE[b.captured] * 10 - VALUE[b.piece] : 0) + (b.promotion ? 800 : 0))
    - ((a.captured ? VALUE[a.captured] * 10 - VALUE[a.piece] : 0) + (a.promotion ? 800 : 0)));
}
/* The search stops at a deadline, so one bot never holds the server (one thread, every room)
   for long: it thinks one move deep, then two, then three, and plays the deepest it finished. */
const OutOfTime = Symbol("out of time");
let deadline = Infinity;
function negamax(chess, depth, alpha, beta, sign) {
  if (Date.now() > deadline) throw OutOfTime;
  if (chess.isCheckmate()) return -100000 - depth;
  if (chess.isDraw() || chess.isStalemate()) return 0;
  if (depth === 0) return sign * evaluate(chess);
  let best = -Infinity;
  for (const m of ordered(chess)) {
    chess.move(m);
    let v;
    // Undone on the way out, out of time or not: a stop deep in the search must leave the board as it was.
    try { v = -negamax(chess, depth - 1, -beta, -alpha, -sign); } finally { chess.undo(); }
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}
function searchAt(chess, depth, rand) {
  const sign = chess.turn() === "w" ? 1 : -1;
  let best = -Infinity, picks = [];
  for (const m of ordered(chess)) {
    chess.move(m);
    let v;
    try { v = -negamax(chess, depth - 1, -Infinity, Infinity, -sign); } finally { chess.undo(); }
    if (v > best + 1e-9) { best = v; picks = [m]; } else if (Math.abs(v - best) < 1e-9) picks.push(m);
  }
  return picks.length ? picks[Math.floor(rand() * picks.length)] : null;
}
function botMove(chess, depth = 3, rand = Math.random, budgetMs = Number(process.env.BOT_BUDGET_MS || 800)) {
  let chosen = null;
  deadline = Date.now() + budgetMs;
  try {
    for (let d = 1; d <= depth; d++) {
      const m = searchAt(chess, d, rand);
      if (m) chosen = m;
      // A mate found is played at once.
      if (m && d >= 1) { chess.move(m); const mate = chess.isCheckmate(); chess.undo(); if (mate) break; }
    }
  } catch (e) {
    if (e !== OutOfTime) throw e;
  } finally {
    deadline = Infinity;
  }
  return chosen ? chosen.from + chosen.to + (chosen.promotion || "") : null;
}

module.exports = { Chess, boardOf, legalMoves, outcome, evaluate, botMove };
