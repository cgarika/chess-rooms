/* GameNest Plus: chess puzzles (the owner, 2026-10-17, "yes" to ref/chess_looks/plus_review_puzzle.png).

   3150 well-proven puzzles from the Lichess puzzle database (CC0, database.lichess.org; picked by
   gamenest-unreal's ~/Library/GameNest/Work/tools/lichess_puzzles.py), 150 a 100-point band from 600 to 2699. Each is
   { id, fen, moves, rating, themes }: the position, then the opponent's move that sets it, then the solver's moves
   and the replies in turn.

   The daily one (the same for everyone on a UTC day, 1000-1800) is free; any other is GameNest Plus's.
   A move is right when it is the solution's, or any mate where the solution mates. The state for the app is the
   board as a room's ({ board, legal, turn, lastMove }), so the chess screen draws a puzzle as it draws a game. */
"use strict";
const { Chess, boardOf, legalMoves } = require("./game");
const ALL = require("./puzzles.json");
const BY_ID = new Map(ALL.map((p) => [p.id, p]));

function dayIndex(date = new Date()) {
  return Math.floor(date.getTime() / 86400000);
}

/* The day's puzzle: the same for everyone on a UTC day, rated 1000-1800, a different one each day. */
function daily(date = new Date()) {
  const pool = ALL.filter((p) => p.rating >= 1000 && p.rating < 1800);
  const d = dayIndex(date);
  return pool[(d * 2654435761 >>> 0) % pool.length];
}

/* A puzzle near the solver's rating (within 150, widened if all of those were seen), not one of seen. */
function near(rating, seen = [], rand = Math.random) {
  const skip = new Set(Array.isArray(seen) ? seen.slice(-200) : []);
  const r = Number.isFinite(rating) ? Math.max(600, Math.min(2650, rating)) : 1200;
  for (const span of [150, 300, 600, 3000]) {
    const pool = ALL.filter((p) => Math.abs(p.rating - r) <= span && !skip.has(p.id));
    if (pool.length) return pool[Math.floor(rand() * pool.length)];
  }
  return ALL[Math.floor(rand() * ALL.length)];
}

function uciOf(m) { return m.from + m.to + (m.promotion || ""); }

function play(chess, uci) {
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

/* A puzzle after the solver's moves so far (done: their uci, the replies left out), the next one tried (try, may be
   null). Returns the state for the app:
     { id, rating, themes, headline, board, legal, turn, lastMove, status: "playing" | "wrong" | "solved", solved, hintFrom }
   "wrong" leaves the board before the wrong move (the solver tries again). */
function step(puzzle, done = [], tryUci = null) {
  const chess = new Chess(puzzle.fen);
  const line = puzzle.moves;
  play(chess, line[0]);   // the opponent's move that sets it
  let at = 1;
  for (const u of done) {   // each of the solver's moves already accepted, and its reply
    if (at >= line.length) break;
    if (u !== line[at] && !matesLike(chess, u, line[at])) return null;   // not a line this puzzle has
    play(chess, u);
    at += 1;
    if (at < line.length) { play(chess, line[at]); at += 1; }
  }
  let status = at >= line.length ? "solved" : "playing";
  let reply = null;
  if (tryUci && status === "playing") {
    if (tryUci === line[at] || matesLike(chess, tryUci, line[at])) {
      play(chess, tryUci);
      at += 1;
      if (at < line.length) { reply = line[at]; play(chess, reply); at += 1; }
      status = at >= line.length ? "solved" : "playing";
    } else if (legalMoves(chess).includes(tryUci)) {
      status = "wrong";
    }
  }
  const history = chess.history({ verbose: true });
  const last = history[history.length - 1];
  return {
    id: puzzle.id, rating: puzzle.rating, themes: puzzle.themes, headline: headline(puzzle),
    board: boardOf(chess), legal: status === "playing" ? legalMoves(chess) : [], turn: chess.turn(),
    lastMove: last ? uciOf(last) : null, reply, status, solverColour: new Chess(puzzle.fen).turn() === "w" ? "b" : "w",
    hintFrom: status === "playing" ? line[at].slice(0, 2) : null,
  };
}

/* On a mate the puzzle wants, any mating move is right. */
function matesLike(chess, uci, want) {
  if (!want) return false;
  const a = new Chess(chess.fen());
  const b = new Chess(chess.fen());
  try { play(a, want); } catch (e) { return false; }
  if (!a.isCheckmate()) return false;
  try { play(b, uci); } catch (e) { return false; }
  return b.isCheckmate();
}

function headline(p) {
  const side = new Chess(p.fen).turn() === "w" ? "Black" : "White";   // the opponent moves first
  const mate = (p.themes || []).find((t) => /^mateIn\d$/.test(t));
  if (mate) return `${side} to move - mate in ${mate.slice(6)}`;
  return `${side} to move - find the best move`;
}

/* The solver's new puzzle rating after one: Elo with K 24 against the puzzle's own rating. */
function rated(solverRating, puzzleRating, solved) {
  const r = Number.isFinite(solverRating) ? solverRating : 1200;
  const expect = 1 / (1 + Math.pow(10, (puzzleRating - r) / 400));
  return Math.round(24 * ((solved ? 1 : 0) - expect));
}

module.exports = { ALL, BY_ID, daily, near, step, rated, headline, dayIndex };
