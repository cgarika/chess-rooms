/* GameNest Plus's analysis board (the owner, 2026-10-17: "yes to all four"): a board of one's own outside any room,
   moved for both sides, taken back, set up by hand, with Stockfish's three best lines beside it. This is the pure
   part: the position a player holds (socket.data.analysis), what the app is sent, and a set-up checked before it is
   taken. The engine's lines come from sf_bot.js's worker. */
"use strict";
const { Chess, validateFen } = require("chess.js");
const { boardOf, legalMoves, outcome } = require("./game");

const START = new Chess().fen();

/* A fresh analysis from a FEN (the start when none, or a bad one). */
function open(fen) {
  let chess;
  try { chess = new Chess(typeof fen === "string" && validateFen(fen).ok ? fen : START); } catch (e) { chess = new Chess(START); }
  return { chess, root: chess.fen(), engine: true };
}

/* A move as "e2e4" (or "e7e8q"), if it is legal there: true when played. */
function move(a, uci) {
  if (typeof uci !== "string" || !legalMoves(a.chess).includes(uci)) return false;
  a.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return true;
}

function undo(a) {
  return !!a.chess.undo();
}

/* A hand-made position: board as the app draws it (rank 1 first, "wK" and so on, "" empty) and who moves. Taken
   when chess.js would play it: one king each, no pawn on the first or last rank, the side not moving not in check.
   Castling is allowed where the king and rook stand at home. Returns null, or why not. */
function setup(a, board, turn) {
  if (!Array.isArray(board) || board.length !== 8 || !board.every((r) => Array.isArray(r) && r.length === 8)) return "That board isn't a chessboard.";
  if (turn !== "w" && turn !== "b") return "Say who moves next.";
  let kings = { w: 0, b: 0 };
  const ranks = [];
  for (let r = 7; r >= 0; r--) {
    let row = "", empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) { empty++; continue; }
      if (typeof p !== "string" || !/^[wb][KQRBNP]$/.test(p)) return "That board isn't a chessboard.";
      if (p[1] === "K") kings[p[0]]++;
      if (p[1] === "P" && (r === 0 || r === 7)) return "Pawns can't stand on the first or last row.";
      if (empty) { row += empty; empty = 0; }
      row += p[0] === "w" ? p[1] : p[1].toLowerCase();
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  if (kings.w !== 1 || kings.b !== 1) return "Each side needs exactly one king.";
  const at = (sq) => board[Number(sq[1]) - 1]["abcdefgh".indexOf(sq[0])];
  let castle = "";
  if (at("e1") === "wK") { if (at("h1") === "wR") castle += "K"; if (at("a1") === "wR") castle += "Q"; }
  if (at("e8") === "bK") { if (at("h8") === "bR") castle += "k"; if (at("a8") === "bR") castle += "q"; }
  const fen = `${ranks.join("/")} ${turn} ${castle || "-"} - 0 1`;
  if (!validateFen(fen).ok) return "That position can't be played.";
  // The side that isn't moving may not be in check (it would be taken).
  const other = new Chess(fen.replace(` ${turn} `, ` ${turn === "w" ? "b" : "w"} `), { skipValidation: true });
  if (other.inCheck()) return "The side not moving is in check.";
  a.chess = new Chess(fen);
  a.root = fen;
  return null;
}

/* What the app is sent: the board, the legal moves, whose turn, the last move, how it stands. */
function view(a) {
  const history = a.chess.history({ verbose: true });
  const last = history[history.length - 1];
  const end = outcome(a.chess);
  return {
    fen: a.chess.fen(), board: boardOf(a.chess), legal: legalMoves(a.chess), turn: a.chess.turn(),
    lastMove: last ? last.from + last.to + (last.promotion || "") : null, canUndo: history.length > 0,
    sans: history.map((m) => m.san), over: end ? end.reason : null, winner: end ? end.winner : null, engine: a.engine,
  };
}

module.exports = { START, open, move, undo, setup, view };
