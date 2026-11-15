const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
require("./plus_stats").mount(app, BASE, express);   // GameNest Plus's counters (2026-10-18): counts a day, no ids
require("./gn_stats").mount(app, BASE, express);   // anonymous stats, crash notes and player reports (2026-10-24): counts, no names, no addresses
const server = http.createServer(app);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true } });
/* Every client event goes through one guard (as in Nightfall and Word Spies, less their flood limit). A payload that
   is not an object (null, a number, a string, an array) arrives as {}: 42["join",null] used to throw inside the
   handler's destructuring and stop the whole process, every room with it. A handler that still throws is logged and
   the server carries on. */
function guarded(socket) {
  return (event, fn) => socket.on(event, (payload, ...rest) => {
    try { fn(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, ...rest); }
    catch (e) { console.error(`[${new Date().toISOString()}] ${event} failed:`, (e && e.stack) || e); }
  });
}

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 2;
const TURN_MS = Number(process.env.TURN_MS || 180000);   // three minutes a move against a person: chess wants thinking
const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 5000));   // T1: turn clock while the current player is disconnected
const TIMEOUTS_TO_BOT = 3;                                              // consecutive timeouts before a bot takes the seat
const BOT_MS = Math.max(1, Number(process.env.BOT_MS || 900));

const { Chess, boardOf, legalMoves, outcome, botMove } = require("./game");
const { Worker } = require("worker_threads");
const Puzzles = require("./puzzles");
const Analysis = require("./analysis");   // GameNest Plus's analysis board (2026-10-17)
const MaiaBot = require("./maia");   // the free bots as people: Maia-2 (Hugging Face, 2026-10-18)
const SfBot = require("./sf_bot");   // GameNest Plus's Expert and Master coaches: Stockfish, off the rooms' thread   // GameNest Plus: the daily puzzle (free) and the rest (Plus), 2026-10-17
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)
const Coach = require("./coach");   // the coach's stock: hints, take-backs and review tickets (2026-11-13)
const BOT_DEPTH = Math.max(1, Number(process.env.BOT_DEPTH || 3));
const COLORS = ["#f2ede0", "#3b3f4a"];   // ivory and slate: the colours a seat's stone is cut from this game
const BOT_NAMES = ["Robo", "Chip", "Bolt", "Dicey", "Turbo", "Pixel", "Gizmo", "Widget"];
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const roomSockets = new Map();
const timers = new Map();
const botTimers = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
const newCode = () => {
  const A = "ABCDEFGHJKMNPRTWXYZ";
  let c = "";
  for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  return rooms.has(c) ? newCode() : c;
};
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
/* GN-30: one name cap for every game, 18 UTF-16 units (as the app counts), cut only between whole characters as a
   reader sees them (grapheme clusters), so a name never ends in half an emoji or a flag's lone letter. An avatar is
   one such character (a sticker; a family with skin tones is about 20 units). */
const NAME_MAX = 18, AVATAR_MAX = 24;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function capText(s, max, oneOnly) {
  s = String(s == null ? "" : s).slice(0, 4096).replace(/[<>]/g, "").trim();
  let out = "";
  for (const { segment } of graphemes.segment(s)) {
    if (out.length + segment.length > max) break;
    out += segment;
    if (oneOnly) break;
  }
  return out.trim();
}
const capName = (s) => capText(s, NAME_MAX);
const capAvatar = (s) => capText(s, AVATAR_MAX, true);
/* GN-05: every refusal names its reason for machines as well as people: a "refusal" event { code, message, op }
   first, then "err" as today with the English first and { code, op } after it (codes: not_found, started, full,
   name_required, not_enough_players; the same names as the other GameNest servers). */
function refuse(socket, code, message, op) { socket.emit("refusal", { code, message, op }); socket.emit("err", message, { code, op }); }
/* What this server can do beyond what today's app knows, so a newer client can tell before it relies on it. */
const FEATURES = Object.freeze(["refusalCodes", "serverNow", "waitList", "reactions", "review", "puzzles"]);
function clearT(map, code) { const t = map.get(code); if (t) { if (typeof t.cancel === "function") t.cancel(); else clearTimeout(t); map.delete(code); } }
function deleteRoom(code) { clearT(timers, code); clearT(botTimers, code); rooms.delete(code); roomSockets.delete(code); }
function activeSeats(room) { return room.players.map((p, i) => (!p.left ? i : -1)).filter((i) => i >= 0); }

/* Chess clocks (the owner, 2026-10-03: "compete with chess.com"): a time control is minutes for
   each side and seconds added after each move ("3+2"). Each side's clock runs only on its own turn,
   and only from White's first move (as the big sites do); running out loses, unless the other side
   has too little left to mate, which is a draw. "none" is no clock: the per-move rule then applies. */
const CONTROLS = ["none", "1+0", "3+2", "5+0", "10+0", "15+10"];
function parseControl(tc) {
  const m = /^(\d+)\+(\d+)$/.exec(tc || "");
  // CLOCK_SCALE shortens every control for the tests (0.005 makes a minute 300 ms).
  const k = Number(process.env.CLOCK_SCALE || 1);
  return m ? { base: Number(m[1]) * 60000 * k, inc: Number(m[2]) * 1000 * k } : null;
}
/* Takes the time the side to move has used off its clock; true when it has run out. */
function chargeClock(room) {
  const c = room.clock;
  if (!c || !c.running) return false;
  const now = Date.now();
  c[c.running] -= now - c.since;
  c.since = now;
  return c[c.running] <= 0;
}
/* Who has nothing to mate with: a lone king, or a king and one knight or bishop. */
function cannotMate(chess, colour) {
  const left = [];
  for (const rank of chess.board()) for (const sq of rank) if (sq && sq.color === colour && sq.type !== "k") left.push(sq.type);
  return left.length === 0 || (left.length === 1 && (left[0] === "n" || left[0] === "b"));
}
function flagFall(room) {
  const loser = room.clock.running;
  room.clock[loser] = 0;
  room.clock.running = null;
  const other = loser === "w" ? "b" : "w";
  const winner = cannotMate(room.chess, other) ? null : seatOf(room, other);
  finish(room, winner, winner === null ? "timeoutDraw" : "time");
  room.log = winner === null ? "Time ran out, but nobody can mate: a draw." : `${room.players[winner].name} wins on time!`;
}

/* The control in force: the host's choice, else none against a bot (as the big sites) and ten minutes between people. */
function tcOf(room) {
  if (room.tc) return room.tc;
  // BOT_TC: a default control against bots, for trying the clock out (none unless set).
  return activeSeats(room).some((s) => room.players[s] && room.players[s].bot) ? (process.env.BOT_TC || "none") : "10+0";
}
function positionsOf(chess) {
  const h = chess.history({ verbose: true });
  const out = [(h.length ? h[0].before : chess.fen()).split(" ")[0]];
  for (const m of h) out.push(m.after.split(" ")[0]);
  return out;
}

function setupGame(room) {
  room.review = null;   // a new game: the last one's review goes with it
  /* The coach's stock (2026-11-13): a new game has its own id, nobody has opened its review with a ticket, the coach has
     not helped in it (a game he helps in is not rated), no hint of the last game is left on the board, and every seat's
     free hints and take-back are back. */
  room.reviewFor = null;
  room.helped = false;
  room.gameId = newId().slice(0, 8);
  room.hint = null;
  for (const p of room.players) if (p.ck) Coach.fresh(p.ck);
  // START_FEN: a test-only starting position (check, promotion, stalemate), never set in production.
  room.chess = process.env.START_FEN ? new Chess(process.env.START_FEN) : new Chess();
  const control = parseControl(tcOf(room));
  room.clock = control ? { w: control.base, b: control.base, inc: control.inc, running: null, since: 0 } : null;
  const act = activeSeats(room);
  // White alternates game to game; the first game, a seat drawn at random.
  // The first game against the coach (one person, one bot) is the person's with White, as a new player expects (chess r1: the board then has a1 at the bottom left); rematches swap.
  const people = act.filter((s) => !room.players[s].bot);
  room.white = room.white === undefined ? (act.length === 2 && people.length === 1 ? people[0] : act[crypto.randomInt(act.length)]) : act[(act.indexOf(room.white) + 1) % act.length];
  if (process.env.START_WHITE === "host") room.white = act[0];   // tests: the host has white
  // Whoever the position says is to move (a test position may start with black).
  room.turn = room.chess.turn() === "w" ? room.white : act.find((s) => s !== room.white);
  room.lastMove = null;
  room.offer = null; room.offerBlock = {};
  room.winner = null;
  room.result = null;
  room.standings = null;
  room.status = "playing";
  room.log = `${room.players[room.turn].name} has white and moves first.`;
  armTimer(room.code);
}
const colourOf = (room, seat) => (seat === room.white ? "w" : "b");
const seatOf = (room, colour) => (colour === "w" ? room.white : activeSeats(room).find((s) => s !== room.white));

function nextTurn(room) {
  const act = activeSeats(room);
  const i = act.indexOf(room.turn);
  room.turn = act[(i + 1) % act.length];
}

function finish(room, winner, reason) {
  if (winner !== null && winner !== undefined && winner >= 0) Reactions.event(room, winner, "win", bump, 1500);
  room.status = "over";
  room.offer = null;
  room.phaseEndsAt = null;
  if (room.clock) { chargeClock(room); room.clock.running = null; }
  room.winner = winner;
  room.result = { reason, winner: winner === null || winner === undefined ? -1 : winner };
  room.wins = room.wins || room.players.map(() => 0);
  while (room.wins.length < room.players.length) room.wins.push(0);
  if (winner !== null && winner !== undefined && winner >= 0) room.wins[winner]++;
  room.standings = room.players.map((q, i) => ({ seat: i, left: q.left }))
    .sort((a, b) => (a.seat === winner ? -1 : b.seat === winner ? 1 : a.seat - b.seat));
  clearT(timers, room.code); clearT(botTimers, room.code);
}

/* A move as "e2e4" (or "e7e8q"): legal for the side to move, else nothing happens. */
function applyMove(room, uci) {
  if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false;
  const seat = room.turn;
  // The mover's time first: a move made after the flag fell is no move.
  if (room.clock && chargeClock(room)) { flagFall(room); return true; }
  let m = null;
  try { m = room.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); } catch (e) { return false; }
  if (!m) return false;
  room.hint = null;
  room.offer = null;   // any move answers a pending offer: it is off
  room.lastMove = {
    seat, from: m.from, to: m.to, san: m.san, piece: m.piece, captured: m.captured || null, promotion: m.promotion || null,
    castle: m.flags.includes("k") ? "king" : m.flags.includes("q") ? "queen" : null, enPassant: m.flags.includes("e"),
    check: room.chess.inCheck(), mv: (room.lastMove ? room.lastMove.mv : 0) + 1,
  };
  const pl = room.players[seat];
  /* The bots' reactions (2026-10-15), once the app has played the capture: a queen or a rook lost and taken. */
  if (m.captured === "q" || m.captured === "r") {
    const other = room.players.findIndex((_, i) => i !== seat && !room.players[i].left);
    if (other >= 0) Reactions.event(room, other, "bad", bump, 1500);
    Reactions.event(room, seat, "good", bump, 1500);
  }
  const end = outcome(room.chess);
  if (end) {
    const winner = end.winner ? seatOf(room, end.winner) : null;
    finish(room, winner, end.reason);
    room.log = end.reason === "checkmate" ? `Checkmate! ${pl.name.toUpperCase()} WINS! 🏆`
      : end.reason === "stalemate" ? "Stalemate: a draw." : end.reason === "repetition" ? "The same position three times: a draw."
      : end.reason === "material" ? "Not enough left to mate: a draw." : "Fifty moves without a capture or a pawn move: a draw.";
    return true;
  }
  nextTurn(room);
  if (room.clock) {
    const mover = m.color, next = mover === "w" ? "b" : "w";
    // The increment once the clock is running (not for White's first move, which starts it).
    if (room.clock.running) room.clock[mover] += room.clock.inc;
    room.clock.running = next;
    room.clock.since = Date.now();
  }
  room.log = `${pl.name} played ${m.san}.`;
  return true;
}
/* The move a bot (or a timed-out player) makes. */
/* How hard the bot plays, the host's choice in the lobby: how far it looks, and how long it may think. */
// The free three play like people of about 1000, 1400 and 1900 (maia.js; Easy's a beginner's slips, Hard close to its
// favourite move); depth and ms are the old way, if Maia-2 is not there.
const LEVELS = { easy: { depth: 1, ms: 150, maia: { elo: 1000, temp: 1 } }, normal: { depth: 2, ms: 500, maia: { elo: 1400, temp: 0.7 } },
  hard: { depth: BOT_DEPTH, ms: 900, maia: { elo: 1900, temp: 0.4 } },
  // GameNest Plus's (2026-10-17): Stockfish held to 2000, and Stockfish at its full strength; a Plus room's only.
  expert: { depth: BOT_DEPTH, ms: 900, sf: { elo: 2000, movetimeMs: 500 } }, master: { depth: BOT_DEPTH, ms: 900, sf: { elo: null, movetimeMs: 900 } } };
function botCol(room, budgetMs) {
  const L = LEVELS[room.level] || LEVELS.normal;
  // Easy also blunders now and then: one move in four is any legal move.
  if (room.level === "easy" && crypto.randomInt(4) === 0) { const ms = legalMoves(room.chess); return ms[crypto.randomInt(ms.length)]; }
  return botMove(room.chess, L.depth, Math.random, budgetMs ? Math.min(L.ms, budgetMs) : L.ms);
}

/* ---------- how long a bot takes (pacing round 1, 2026-11-01) ----------
   A bot's ply takes what a person's would: 0.8-2.5 s by what the position asks (a forced move or a recapture is quick,
   a crowded middlegame is not), so the three bots do not feel like one metronome; and it is on the board within BOT_HARD_MS
   (2.8 s) of its turn whatever the engine does: the engine is asked at once and thinks while the bot "thinks", and a
   watchdog plays the old way's move (botCol, a short search) when no answer is there by BOT_HARD_MS - FALLBACK_MS. The
   owner's bar: no bot ply over 3 s. BOT_MS scales the thinking for the tests (BOT_MS=5 is nearly none); the hard stop does not. */
const THINK_MIN_MS = 800, THINK_MAX_MS = 2500;
const BOT_HARD_MS = Math.max(50, Number(process.env.BOT_HARD_MS || 2800));
const FALLBACK_MS = 300;
const THINK_SCALE = BOT_MS / 900;
const LEVEL_PACE = { easy: 0.85, normal: 1, hard: 1.05, expert: 1.05, master: 1.05 };
function thinkMs(room, rand = Math.random) {
  let ms = 1500;
  try {
    const chess = room.chess;
    const moves = chess.moves({ verbose: true });
    const n = moves.length;
    const hist = chess.history({ verbose: true });
    const last = hist.length ? hist[hist.length - 1] : null;
    const caps = moves.filter((m) => m.captured).length;
    const recapture = !!(last && last.captured && moves.some((m) => m.captured && m.to === last.to));
    const jitter = (lo, hi) => lo + rand() * (hi - lo);
    if (n <= 1) ms = jitter(800, 950);                                  // forced: nothing to think about
    else if (recapture && caps <= 2) ms = jitter(850, 1250);             // taking back is quick
    else if (chess.inCheck() && n <= 4) ms = jitter(900, 1300);          // an answer to a check
    else if ((Number(chess.fen().split(" ")[5]) || 1) <= 4) ms = jitter(800, 1300);   // the first four moves are known
    else {
      const crowd = Math.max(0, Math.min(1, (n - 10) / 30));            // 10 moves or fewer: a quiet position; 40: a crowded one
      const centre = 800 + 750 * crowd + 100 * Math.min(caps, 3) + (caps >= 4 || chess.inCheck() ? 350 : 0);   // a mess of captures, or a check with room to answer it: longer
      ms = centre * jitter(0.85, 1.15);
    }
    ms *= LEVEL_PACE[room.level] || 1;
    // Short of time on a clock: no long thoughts.
    if (room.clock && room.white !== undefined) {
      const mine = room.clock[chess.turn()];
      if (mine < 20000) ms = Math.min(ms, 800);
    }
  } catch (e) { /* a position this cannot read thinks for the middle of the range */ }
  ms = Math.max(THINK_MIN_MS, Math.min(THINK_MAX_MS, ms));
  return Math.max(1, Math.round(ms * THINK_SCALE));
}
/* Every bot ply is logged as one JSON line (chess r1, 2026-11-02: "each ply logs its engine and any fallback"): the room, the level, the ply, the
   move, which engine decided it (maia2, stockfish, or the old negamax), how it came (engine: its answer, watchdog: the answer was late, classic:
   the old way by design, fallback: the engine failed and the old way played, random: even that failed), the milliseconds from the bot's turn to its
   move, and why a fallback was needed. tools/bot_log_stats.js reads the lines back (p50, p95, max). BOT_LOG=0 mutes it (the tests). */
const BOT_LOG = process.env.BOT_LOG !== "0";
function logPly(room, how, ms, reason) {
  if (!BOT_LOG) return;
  const L = LEVELS[room.level];
  const engine = L && L.sf ? "stockfish" : L && L.maia && MaiaBot.available && MaiaBot.available() ? "maia2" : "negamax";
  const line = { bot: "ply", at: new Date().toISOString(), room: room.code, level: room.level, ply: room.chess ? room.chess.history().length : 0,
    san: room.lastMove ? room.lastMove.san : null, engine: how === "classic" || how === "random" ? "negamax" : engine, how, ms };
  if (how === "fallback" || how === "random" || how === "watchdog") line.fallback = reason || "no answer";
  console.log(JSON.stringify(line));
}
/* What the bots have done, for the soak test and the log: how each ply was decided and how long it took. */
const botStats = { plies: 0, engine: 0, classic: 0, fallback: 0, random: 0, max: 0, ms: [] };
function noteBot(how, ms) {
  botStats.plies++; botStats[how] = (botStats[how] || 0) + 1; botStats.max = Math.max(botStats.max, ms);
  botStats.ms.push(ms); if (botStats.ms.length > 5000) botStats.ms.shift();
}
function captured(room) {
  const out = { w: [], b: [] };
  if (!room.chess) return out;
  const left = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const rank of room.chess.board()) for (const sq of rank) if (sq && sq.type !== "k") left[sq.color][sq.type]++;
  for (const c of ["w", "b"]) for (const t of ["q", "r", "b", "n", "p"]) for (let i = left[c][t]; i < START[t]; i++) out[c].push(t);
  return out;
}

function armTimer(code) {
  const room = rooms.get(code);
  clearT(timers, code);
  scheduleBot(code);
  if (!room || room.status !== "playing") { if (room) room.phaseEndsAt = null; return; }
  // A clock: the deadline is the side to move's flag (from White's first move), whoever plays it.
  if (room.clock) {
    if (!room.clock.running) { room.phaseEndsAt = null; return; }
    const left = room.clock[room.clock.running];
    room.phaseEndsAt = Date.now() + left;
    timers.set(code, setTimeout(() => {
      const r = rooms.get(code);
      if (!r || r.status !== "playing" || !r.clock || !r.clock.running) return;
      if (chargeClock(r)) { flagFall(r); bump(r); } else armTimer(code);
    }, Math.max(0, left) + 30));
    return;
  }
  const cur = room.players[room.turn];
  const human = cur && !cur.bot && !cur.botControlled;
  // Against bots only, a person thinks as long as they like (the owner: a minute a move was harsh); away is still away.
  const onlyBots = human && activeSeats(room).every((s) => s === room.turn || room.players[s].bot);
  if (human && cur.connected && onlyBots) { room.phaseEndsAt = null; return; }
  const ms = human && !cur.connected ? AFK_MS : TURN_MS;
  room.phaseEndsAt = Date.now() + ms;
  timers.set(code, setTimeout(() => onTurnTimeout(code), ms));
}

/* T1 AFK policy: a timed-out turn is rolled for the player (the bot heuristic here is the roll itself);
   three consecutive timeouts hand the seat to the bot until the human acts or reconnects. */
function onTurnTimeout(code) {
  const r = rooms.get(code);
  if (!r || r.status !== "playing") return;
  const pl = r.players[r.turn];
  if (!pl) return;
  let note = "";
  if (!pl.bot && !pl.botControlled) {
    pl.timeouts = (pl.timeouts || 0) + 1;
    if (pl.timeouts >= TIMEOUTS_TO_BOT) { pl.botControlled = true; note = `A bot is playing for ${pl.name} (timed out ${TIMEOUTS_TO_BOT} times).`; }
    else note = `${pl.name} ran out of time; the turn was played for them.`;
  }
  applyMove(r, botCol(r));
  if (note) r.log = `${note} ${r.log || ""}`.trim();
  if (r.status === "playing") armTimer(code);   // GN-10: the deadline is set before the state that shows it
  bump(r);
}

/* The human acts (or reconnects): take the seat back from the bot and reset the timeout streak. */
function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back at the table${reason ? " (" + reason + ")" : ""}.`;
  if (room.status === "playing" && room.players[room.turn] === p) { clearT(botTimers, room.code); armTimer(room.code); }
  return true;
}

function addBotTo(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const used = room.players.map((q) => q.name);
  const name = BOT_NAMES.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, left: false, connected: true };
  room.players.push(p);
  return p;
}
/* ---------- draw and take-back offers ---------- */
const MATERIAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function materialOf(chess, colour) {
  let t = 0;
  for (const rank of chess.board()) for (const sq of rank) if (sq && sq.color === colour && MATERIAL[sq.type]) t += MATERIAL[sq.type];
  return t;
}
const plies = (room) => (room.chess ? room.chess.history().length : 0);
/* Plies to undo for a take-back of seat's last move: 1 if the opponent has not replied, 2 if they have; 0 when the seat has made no move. */
function takebackPlies(room, seat) {
  const mine = colourOf(room, seat);
  const h = room.chess.history({ verbose: true });
  if (!h.some((m) => m.color === mine)) return 0;
  const n = room.chess.turn() === mine ? 2 : 1;
  return h.length >= n && h[h.length - n].color === mine ? n : 0;
}
function undoPlies(room, n) {
  for (let i = 0; i < n; i++) room.chess.undo();
  const h = room.chess.history({ verbose: true });
  const m = h[h.length - 1];
  room.lastMove = m ? {
    seat: seatOf(room, m.color), from: m.from, to: m.to, san: m.san, piece: m.piece, captured: m.captured || null, promotion: m.promotion || null,
    castle: m.flags.includes("k") ? "king" : m.flags.includes("q") ? "queen" : null, enPassant: m.flags.includes("e"),
    check: room.chess.inCheck(), mv: h.length,
  } : null;
  room.hint = null;
  room.turn = seatOf(room, room.chess.turn());
  if (room.clock) {
    chargeClock(room);   // the time used so far is kept as it is
    room.clock.running = h.length ? room.chess.turn() : null;
    room.clock.since = Date.now();
  }
}
function settleOffer(room, accept) {
  const o = room.offer, from = o.from, kind = o.kind;
  room.offer = null;
  const asker = room.players[from].name;
  if (accept && kind === "draw") { finish(room, null, "agreement"); room.log = "Draw agreed."; return; }
  if (accept) {
    const n = takebackPlies(room, from);
    if (n) { undoPlies(room, n); room.log = `${asker}'s move was taken back.`; }
    if (room.status === "playing") armTimer(room.code);   // the bot's and the turn's timers: the position changed
    return;
  }
  room.offerBlock = room.offerBlock || {};
  room.offerBlock[from + kind] = plies(room);
  room.log = `${room.players[room.players.findIndex((p, i) => i !== from && !p.left)].name} declines the ${kind === "draw" ? "draw" : "take-back"}.`;
}
/* The bot answers at once: a take-back always; a draw when it is not ahead and ten full moves are played. */
function botAnswers(room, botSeat) {
  const o = room.offer;
  if (o.kind === "takeback") return true;
  const bc = colourOf(room, botSeat), hc = bc === "w" ? "b" : "w";
  return plies(room) >= 20 && materialOf(room.chess, bc) <= materialOf(room.chess, hc);
}

function scheduleBot(code) {
  clearT(botTimers, code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const p = room.players[room.turn];
  if (!p || !(p.bot || p.botControlled)) return;
  const t0 = Date.now(), seat = room.turn, fen = room.chess.fen();
  const L = LEVELS[room.level];
  const engine = !!(L && (L.sf || L.maia) && p.bot);   // Stockfish (or Maia-2) thinks in its worker; the rest play the old way
  const delay = thinkMs(room);
  let over = false, answered = !engine, answer = null, thought = false, reason = "";
  let thinkTimer = null, watchdog = null;
  const turn = { cancel() { over = true; clearTimeout(thinkTimer); clearTimeout(watchdog); } };
  botTimers.set(code, turn);

  /* The bot's move, once: the engine's if it came and is legal, else the old way's, else any legal move. Whatever goes wrong
     here, the turn is played. */
  const play = (uci, how) => {
    if (over) return;
    turn.cancel();
    if (botTimers.get(code) === turn) botTimers.delete(code);
    const now = rooms.get(code);
    // The position moved on (a take-back, a seat that left): not this move's turn any more.
    if (!now || now.status !== "playing" || now.turn !== seat || now.chess.fen() !== fen) return;
    const who = now.players[now.turn];
    if (!who || !(who.bot || who.botControlled)) return;
    const spent = Date.now() - t0;
    let moved = false, by = how;
    try { moved = !!uci && legalMoves(now.chess).includes(uci) && applyMove(now, uci); } catch (e) { moved = false; }
    if (!moved) {
      if (how === "engine" || how === "watchdog") { by = "fallback"; console.warn(`[${new Date().toISOString()}] chess bot ${now.code} ${now.level}: ${reason || (uci ? "an illegal move " + uci : "no answer")} after ${spent} ms, played the old way`); }
      // The old way gets what is left of the hard stop (at least 100 ms), never more than its level's own budget (a fallback: 600 ms).
      const budget = Math.max(100, Math.min(how === "classic" ? 1e9 : FALLBACK_MS * 2, BOT_HARD_MS - spent - 100));
      try { moved = !!applyMove(now, botCol(now, budget)); } catch (e) { moved = false; }
    }
    if (!moved && now.status === "playing") {
      by = "random";
      try { const ms = legalMoves(now.chess); moved = ms.length > 0 && !!applyMove(now, ms[crypto.randomInt(ms.length)]); } catch (e) { moved = false; }
    }
    const took = Date.now() - t0;
    noteBot(by, took);
    logPly(now, by, took, reason);
    if (now.status === "playing") armTimer(code);   // GN-10
    bump(now);
  };

  if (engine) {
    // Asked now, not after the thinking: the model's few milliseconds (or a slow worker's wait) happen inside it.
    let asked;
    try { asked = L.sf ? SfBot.move(fen, Object.assign({}, L.sf, { timeoutMs: BOT_HARD_MS - FALLBACK_MS })) : MaiaBot.move(room.chess, Object.assign({}, L.maia, { timeoutMs: BOT_HARD_MS - FALLBACK_MS })); }
    catch (e) { asked = Promise.reject(e); }
    Promise.resolve(asked).then((uci) => uci, (e) => { reason = "the engine threw: " + ((e && e.message) || e); return null; }).then((uci) => {
      answered = true; answer = uci || null;
      if (!answer && !reason) reason = "the engine gave no move";
      if (thought) play(answer, "engine");
    });
  }
  thinkTimer = setTimeout(() => { thought = true; if (answered) play(answer, engine ? "engine" : "classic"); }, delay);
  // The watchdog: no answer by then (a worker that hangs), the old way's short search plays.
  watchdog = setTimeout(() => { if (!answered && !reason) reason = "no answer in time"; play(answer, engine ? "watchdog" : "classic"); }, Math.max(delay, BOT_HARD_MS - FALLBACK_MS));
}

function stateFor(room) {
  const playing = room.status === "playing" && room.chess;
  return {
    code: room.code, status: room.status, phase: playing ? "move" : room.status,
    turn: room.turn, white: room.white === undefined ? -1 : room.white,
    fen: room.chess ? room.chess.fen() : null, board: room.chess ? boardOf(room.chess) : null,
    legal: playing ? legalMoves(room.chess) : [],
    check: playing ? room.chess.inCheck() : false,
    lastMove: room.lastMove, winner: room.winner, result: room.result || null,
    captured: captured(room),
    moves: room.chess ? room.chess.history() : [],
    // Every position of the game so far, as the board part of a FEN, the start first: the app steps
    // back through them (its ⟲ and ⟳, after the owner's Duolingo recording).
    positions: room.chess ? positionsOf(room.chess) : [],
    level: room.level || "normal",
    hint: playing && room.hint ? room.hint : null,
    // A draw or take-back offer waiting for an answer: { kind: "draw" | "takeback", from: seat } or null. caps: what this room's server can do.
    offer: playing && room.offer ? room.offer : null,
    caps: ["offers"],
    tc: tcOf(room),
    controls: CONTROLS,
    // GameNest Plus's game review, once asked for at the end: { status: "running" | "done" | "error", progress, plies, accuracy, rating }.
    review: room.status === "over" && room.review ? room.review : null,
    clock: room.clock ? { w: Math.max(0, Math.round(room.clock.w - (room.clock.running === "w" ? Date.now() - room.clock.since : 0))), b: Math.max(0, Math.round(room.clock.b - (room.clock.running === "b" ? Date.now() - room.clock.since : 0))), running: room.clock.running, inc: room.clock.inc } : null,
    wins: room.players.map((p, s) => (room.wins && room.wins[s]) || 0),
    standings: room.standings, log: room.log, phaseEndsAt: room.phaseEndsAt || null,
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: room.players.map((p, s) => ({
      name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, botControlled: !!p.botControlled, left: p.left, connected: p.connected,
      color: room.white === undefined ? COLORS[s % 2] : COLORS[s === room.white ? 0 : 1],
    })),
    voice: room.voice ? Array.from(room.voice) : [],
    chat: (room.chat || []).slice(-60),
    features: FEATURES,
    serverNow: Date.now(),
    ...Reactions.view(room),   // 2026-10-15: reactionsOn and the last reactions
    ...Quick.view(room),   // quick play and ranked (2026-10-24)
  };
}
function bump(room) { room.v = (room.v || 0) + 1; room.touched = Date.now(); sendState(room.code); }

/* ---------- GameNest push (optional; no-op without PUSH_URL) ----------
   The app registers a device token per socket and reports presence; players who are away or disconnected
   get a push when it becomes their turn / a new phase starts, and when someone writes in chat. */
const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = 'Chess';
function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  if (!(p.away || !p.connected)) return;
  const now = Date.now(); if (p._lastPush && now - p._lastPush < 4000) return; p._lastPush = now;
  fetch(PUSH_URL + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }) }).catch(() => {});
}
function pushTurn(room) {   // called after every state broadcast; only fires when the situation changes
  const key = room.status + "|" + room.turn;
  if (room._pushKey === key) return; room._pushKey = key;
  if (room.status !== "playing") return;
  const p = room.players[room.turn]; if (!p) return;
  pushTo(p, "Your turn in " + PUSH_TITLE + " — room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-turn");
}

/* ---------- the waiting line (the owner, 2026-09-29) ----------
   Someone who joins a game already under way (and whose app says "waitList") waits in line,
   watching. A seat someone leaves mid-game goes to the first in line at once, keeping the seat's game. The rest are seated at the next game, bots making room if the table is full. */
function takeLeftSeats(room) {
  if (!true || !room.waiting || !room.waiting.length || room.status === "lobby" || room.status === "over") return false;
  let seated = false;
  for (let seat = 0; seat < room.players.length && room.waiting.length; seat++) {
    const old = room.players[seat];
    if (!old.left) continue;
    const w = room.waiting.shift();
    // The seat keeps its game (its place, its cards, its score); only who sits in it changes.
    room.players[seat] = Object.assign({}, old, { id: w.id, name: w.name, avatar: w.avatar, bot: false, botControlled: false,
      left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look, timeouts: 0, ck: Coach.seat(w.caps, w.coach) });   // never the last sitter's stock
    room.log = `${w.name} took ${old.name}'s seat.`;
    seated = true;
  }
  return seated;
}
function seatTheLine(room) {
  while (room.waiting && room.waiting.length) {
    if (room.players.length >= MAX_PLAYERS) {
      const bot = room.players.findIndex((p) => p.bot);
      if (bot < 0) break;
      room.players.splice(bot, 1);
    }
    const w = room.waiting.shift();
    room.players.push({ id: w.id, name: w.name, avatar: w.avatar, bot: false, left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look, ck: Coach.seat(w.caps, w.coach) });
  }
}
function lineState(room, st, playerId, seat) {
  st.waiting = (room.waiting || []).map((w) => ({ name: w.name, avatar: w.avatar }));
  st.waitPos = seat < 0 ? (room.waiting || []).findIndex((w) => w.id === playerId) + 1 : 0;
  return st;
}

/* ---------- the coach's stock (coach.js, 2026-11-13) ----------
   The coach helps where the other seat is a coach bot, never against a person. What a player is told of it is theirs
   alone, the state's last key, and only for an app that says "coach" in its caps: { game, on, helped, free, me }. */
const coachOn = (room, seat) => room.players.some((q, i) => i !== seat && q.bot && !q.left);
function coachView(room, seat) {
  const p = room.players[seat];
  if (!p || p.bot || !p.ck || !p.ck.knows) return null;
  const me = Coach.me(p.ck);
  me.plus = p.plus === true;   // Plus: no limits, nothing spent
  me.review = !!(room.reviewFor && room.reviewFor.has(p.id));   // this game's review is open to me by a ticket
  return { game: room.status === "lobby" ? null : room.gameId || null, on: coachOn(room, seat), helped: !!room.helped, free: Object.assign({}, Coach.FREE), me };
}
/* A review is the whole room's in a Plus room, as ever; one opened with a ticket is for those who spent one on it. */
const reviewOpenTo = (room, playerId) => Plus.isPlusRoom(room) || !!(room.reviewFor && room.reviewFor.has(playerId));

/* A puzzle's free hints and paid uses are remembered for its player (the `playerId` said with `puzzle`) while the
   server runs, so opening the same puzzle again does not hand out three more. Without a playerId they are the
   connection's. */
const PUZZLE_KEEP_MS = 48 * 3600 * 1000, PUZZLE_SEATS_MAX = 20000;
const puzzleSeats = new Map();   // "<player>|<puzzle>" -> { ck, game, at, hinted: the moves a hint was given for }
function puzzleSeat(playerId, puzzleId, caps, sent, fallback) {
  const who = typeof playerId === "string" && /^[\w.:-]{1,64}$/.test(playerId) ? playerId : fallback || null;
  const key = who ? who + "|" + puzzleId : null;
  let e = key ? puzzleSeats.get(key) : null;
  if (e && Date.now() - e.at > PUZZLE_KEEP_MS) e = null;
  if (!e) {
    e = { ck: Coach.seat(caps, null), game: "pz" + newId().slice(0, 8), at: Date.now(), hinted: new Set() };
    if (key) {
      puzzleSeats.delete(key); puzzleSeats.set(key, e);
      while (puzzleSeats.size > PUZZLE_SEATS_MAX) puzzleSeats.delete(puzzleSeats.keys().next().value);
    }
  }
  e.ck.knows = true;
  Coach.take(e.ck, sent, e.game);
  return e;
}

function sendState(code) {
  const room = rooms.get(code);
  const socks = roomSockets.get(code);
  if (!room || !socks) return;
  for (const s of socks) {
    const seat = room.players.findIndex((p) => p.id === s.data.playerId);
    const st = lineState(room, stateFor(room), s.data.playerId, seat);
    if (st.review && !reviewOpenTo(room, s.data.playerId)) st.review = null;
    const coach = seat >= 0 ? coachView(room, seat) : null;
    if (coach) st.coach = coach;
    s.emit("state", { room: st, mySeat: seat, v: room.v });
    try { pushTurn(room); } catch (_) {}
  }
}


/* T3: the host seat follows the humans — first connected human, else first human still seated, else unchanged. */
function ensureHost(room) {
  const cur = room.players.find((p) => p.id === room.host);
  if (cur && !cur.bot && !cur.left && cur.connected) return false;
  const next = room.players.find((p) => !p.bot && !p.left && p.connected) || room.players.find((p) => !p.bot && !p.left);
  if (!next || next.id === room.host) return false;
  room.host = next.id;
  room.log = `${next.name} is now the host.`;
  return true;
}

/* ---------- GameNest Plus: the game review (review.js, in a worker) ----------
   One review at a time on this server, the others waiting their turn (a review is ~0.25 s a move of one core). */
const REVIEW_MS = Math.max(20, Number(process.env.REVIEW_MS || 250));
const ANALYSIS_MS = Math.max(20, Number(process.env.ANALYSIS_MS || 700));   // the analysis board's search (2026-10-17)
const reviewQueue = [];
let reviewing = false, reviewSeq = 0;
function startReview(room) {
  const moves = room.chess.history({ verbose: true }).map((m) => m.lan);
  const id = ++reviewSeq;
  room.review = { id, status: "running", progress: 0, plies: [], accuracy: null, rating: null };
  reviewQueue.push({ code: room.code, moves, fen: process.env.START_FEN || undefined, id });
  pumpReviews();
  // How each side played, as a rating (Maia-2, maia.js: { w, b }, each { elo, low, high, moves } or null), alongside.
  MaiaBot.rate(moves, { fen: process.env.START_FEN || undefined }).then((rating) => {
    const r = rooms.get(room.code);
    if (rating && r && r.review && r.review.id === id) { r.review.rating = rating; bump(r); }
  });
}
function pumpReviews() {
  if (reviewing || !reviewQueue.length) return;
  const job = reviewQueue.shift();
  const room = rooms.get(job.code);
  if (!room || !room.review || room.review.id !== job.id) return pumpReviews();
  reviewing = true;
  const w = new Worker(require("path").join(__dirname, "review_worker.js"), { workerData: { moves: job.moves, fen: job.fen, budgetMs: REVIEW_MS } });
  const settle = (patch) => {
    const r = rooms.get(job.code);
    // Still the review it was asked for (no rematch since): it lands.
    if (r && r.review && r.review.id === job.id && r.review.status === "running") { Object.assign(r.review, patch); bump(r); }
  };
  let lastBump = 0;
  w.on("message", (m) => {
    if (m.progress !== undefined && Date.now() - lastBump > 400) { lastBump = Date.now(); settle({ progress: m.progress }); }
    if (m.done) settle({ status: "done", progress: 100, plies: m.done.plies, accuracy: m.done.accuracy, engine: m.done.engine });
    if (m.error) settle({ status: "error" });
  });
  const next = () => { reviewing = false; pumpReviews(); };
  w.on("error", () => { settle({ status: "error" }); next(); });
  w.on("exit", next);
}

/* A game the coach helped in (a hint or a take-back he gave an app that knows his stock) is not rated. */
Quick.init({ game: 'chess', model: 'glicko', seats: 2, codeKey: 'code', app, io, rooms, base: BASE, broadcast: sendState, rated: (r) => !r.helped });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);   // the wallet's signed entitlement: every event's `plus` is the checked answer (the Nest Wallet repo, contrib/ROLLOUT.md)
  Quick.hook(socket); Quick.connection(socket);   // before the server's own events
  const on = guarded(socket);   // every client event below goes through the guard
  socket.data.playerId = null;
  socket.data.code = null;
  const currentRoom = () => rooms.get(socket.data.code);
  Reactions.wire({ on, room: currentRoom, me: () => socket.data.playerId, isHost: (r) => r.host === socket.data.playerId, bump });
  /* GN-20: a socket sits in one room at a time. Seating it in another first takes it out of the one it was in, as a
     disconnect would, so it never hears two rooms' states. socket.data.as is the player it sits as. */
  const attach = (code) => {
    if (socket.data.code && socket.data.code !== code) awayFromRoom();
    socket.data.code = code; socket.data.as = socket.data.playerId;
    if (!roomSockets.has(code)) roomSockets.set(code, new Set());
    roomSockets.get(code).add(socket);
  };
  const detach = () => { const set = roomSockets.get(socket.data.code); if (set) set.delete(socket); socket.data.code = null; };
  /* This socket stops being in its room (it disconnected, or it sat down in another room). Its player shows away,
     with the AFK clock if it is their turn, unless another socket of theirs is still in the room (a rejoin that
     beat the old socket's timeout). */
  function awayFromRoom() {
    const room = currentRoom();
    const as = socket.data.as || socket.data.playerId;
    detach();
    if (!room || !rooms.has(room.code)) return;
    const p = room.players.find((q) => q.id === as);
    // A watcher in the waiting line who goes away leaves the line (they can join again).
    if (!p && room.waiting && room.waiting.some((w) => w.id === as)) { room.waiting = room.waiting.filter((w) => w.id !== as); bump(room); return; }
    const still = p && [...(roomSockets.get(room.code) || [])].some((s) => (s.data.as || s.data.playerId) === as);
    if (p && !still) { p.connected = false; if (room.voice) room.voice.delete(room.players.indexOf(p)); ensureHost(room); }
    if (p && !still && room.status === "playing" && room.players[room.turn] === p) armTimer(room.code);   // 5 s clock while they are away (GN-10: before the state)
    room.v++;
    sendState(room.code);
  }

  on("create", ({ name, playerId, avatar, plus, look, crew, caps, coach } = {}) => {
    name = capName(name); if (!name) return refuse(socket, "name_required", "Pick a name first.", "create"); name = Moderation.name(name);
    const code = Plus.crewCode({ plus, crew }, rooms, newCode);   // GameNest Plus's crew code (2026-10-17)
    const room = { code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1, touched: Date.now(), voice: new Set() };
    room.players.push({ id: playerId, name, avatar: capAvatar(avatar) || "\u{1F642}", bot: false, left: false, connected: true, ck: Coach.seat(caps, coach) });
    rooms.set(code, room);
    socket.data.playerId = playerId;
    attach(code);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code });
    bump(room);
  });

  on("join", ({ code, name, playerId, avatar, plus, look, caps, coach } = {}) => {
    code = clean(code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return refuse(socket, "not_found", "No room with that code.", "join");
    socket.data.playerId = playerId;
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      /* The coach's stock: a rejoin that says its caps says its stock again (less this game's paid uses its app has not counted). */
      if (!existing.ck) existing.ck = Coach.seat(caps, coach);
      else if (Array.isArray(caps)) { existing.ck.knows = Coach.knows(caps); Coach.take(existing.ck, coach, room.gameId); }
      existing.connected = true; existing.left = false; humanIsBack(room, existing, "reconnected"); attach(code); stampPlus(code, socket, { plus, look }); socket.emit("joined", { code });
      if (room.status === "playing" && room.players[room.turn] === existing) armTimer(code);   // GN-10: the deadline before the state
      bump(room);
      return;
    }
    if (room.status !== "lobby") {
      // An app that knows the line waits in it; an older one hears the game has started.
      if (!(Array.isArray(caps) && caps.includes("waitList"))) return refuse(socket, "started", "That game already started.", "join");
      room.waiting = room.waiting || [];
      let w = room.waiting.find((q) => q.id === playerId);
      if (!w) {
        if (room.players.filter((p) => !p.left).length + room.waiting.length >= MAX_PLAYERS * 2) return refuse(socket, "full", "Room is full.", "join");
        name = capName(name); if (!name) return refuse(socket, "name_required", "Pick a name first.", "join"); name = Moderation.name(name);
        w = { id: playerId, name, avatar: capAvatar(avatar) || "\u{1F642}", plus: plus === true, acct: Plus.acctOf(socket), look: Plus.cleanLook(look),
          caps: Coach.knows(caps) ? [Coach.CAP] : [], coach: Coach.clean(coach) };
        room.waiting.push(w);
        room.log = `${name} is waiting for a seat.`;
      }
      attach(code);
      socket.emit("joined", { code, waiting: true });
      takeLeftSeats(room);
      bump(room);
      return;
    }
    if (room.players.length >= MAX_PLAYERS) return refuse(socket, "full", "Room is full (2).", "join");
    name = capName(name); if (!name) return refuse(socket, "name_required", "Pick a name first.", "join"); name = Moderation.name(name);
    room.players.push({ id: playerId, name, avatar: capAvatar(avatar) || "\u{1F642}", bot: false, left: false, connected: true, ck: Coach.seat(caps, coach) });
    attach(code);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code });
    room.log = `${name} joined.`;
    bump(room);
  });

  on("settings", ({ level, tc } = {}) => {   // the bot's strength and the time control, the host's choice in the lobby
    const room = currentRoom();
    if (!room || room.host !== socket.data.playerId) return;
    // The bot's strength in the lobby and between games (the app's coach finds the player's level); the clock in the lobby only.
    if (LEVELS[level] && LEVELS[level].sf && !Plus.isPlusRoom(room)) return refuse(socket, "plus", "The Expert and Master coaches come with GameNest Plus.", "settings");
    if (LEVELS[level] && (room.status === "lobby" || room.status === "over")) { room.level = level; room.log = `Bot: ${level}.`; }
    if (CONTROLS.includes(tc) && room.status === "lobby") { room.tc = tc; room.log = tc === "none" ? "No clock." : `Clock: ${tc}.`; }
    bump(room);
  });
  on("addBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    const b = addBotTo(room);
    if (b) { room.log = `${b.name} (bot) joined.`; bump(room); }
  });
  on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { room.players.splice(i, 1); break; }
    bump(room);
  });

  on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < MIN_PLAYERS) return refuse(socket, "not_enough_players", "Need 2 players — add a bot.", "start");
    setupGame(room);
    bump(room);
  });

  on("move", ({ uci, from, to, promotion } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat >= 0 && humanIsBack(room, room.players[seat], "took the seat back")) bump(room);
    if (seat !== room.turn) return;
    const move = typeof uci === "string" ? uci : `${from || ""}${to || ""}${promotion || ""}`;
    if (!applyMove(room, move)) return;
    if (room.status === "playing") armTimer(room.code);   // GN-10
    bump(room);
  });
  // A hint (Duolingo's HINT): a good move for the asker, against the bot only (never a friend), on its turn.
  on("hint", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0 || seat !== room.turn || !room.players.some((p) => p.bot)) return;
    /* The coach's stock (2026-11-13), for an app that knows it: three free hints a game, then one of the stock, or Plus.
       A hint that is on the board is not asked for (or paid for) twice. An older app's hints are as they were. */
    const asker = room.players[seat], counted = !!(asker.ck && asker.ck.knows);
    if (counted && room.hint && room.hint.seat === seat) return;
    const uci = botMove(room.chess, 2, Math.random, 400);
    if (!uci) return;
    if (counted) {
      const got = Coach.use(asker.ck, "hint", asker.plus === true);
      if (!got) return refuse(socket, "coach", Coach.LINES.hint, "hint");
      room.helped = true;
      if (got.paid) socket.emit("coachUsed", { kind: "hint", left: got.left, game: room.gameId });
    }
    room.hint = { seat, from: uci.slice(0, 2), to: uci.slice(2, 4), mv: room.lastMove ? room.lastMove.mv : 0 };
    bump(room);
  });
  /* GameNest Plus's game review: asked for by a player at the end, in a Plus room (anyone in it owns Plus). */
  on("review", ({ ticket } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "over" || !room.chess || room.chess.history().length === 0) return;
    const asker = room.players.find((p) => p.id === socket.data.playerId);
    if (!asker) return;
    let opened = false;
    if (!Plus.isPlusRoom(room) && !(room.reviewFor && room.reviewFor.has(asker.id))) {
      /* A review ticket (2026-11-13): `review { ticket: true }` from an app that knows the coach's stock opens THIS
         finished game's review for its player: one ticket, once; asking again for the same game is free. */
      if (!(ticket === true && asker.ck && asker.ck.knows)) return refuse(socket, "plus", "Game review comes with GameNest Plus.", "review");
      const got = Coach.use(asker.ck, "review", false, {});
      if (!got) return refuse(socket, "coach", Coach.LINES.review, "review");
      (room.reviewFor = room.reviewFor || new Set()).add(asker.id);
      socket.emit("coachUsed", { kind: "review", left: got.left, game: room.gameId });
      opened = true;
    }
    if (room.review && room.review.status !== "error") { if (opened) bump(room); return; }
    startReview(room);
    bump(room);
  });
  /* GameNest Plus's puzzles, outside any room: the day's for everyone, the rest for Plus. socket.data.puzzle is the
     one in hand ({ id, done, hinted, rated }); the app sends its puzzle rating and the ids it has seen. */
  const sendPuzzle = (st, extra) => socket.emit("puzzle", { ...st, ...(extra || {}), serverNow: Date.now() });
  /* The coach's stock in a puzzle (2026-11-13), for an app that says "coach" in the `caps` of its `puzzle`: three free
     hints a puzzle, then one of the stock it said (`coach`), or Plus. A hint is the square to move from, for the move at
     hand; asked again for the same move it costs nothing. Such an app is sent `hintFrom` only for a hint it was given,
     and `coach` ({ game, on, free, me }) with every answer. An older app's puzzles are as they were. */
  const puzzleCoach = (cur) => ({ game: cur.seat.game, on: true, free: Object.assign({}, Coach.PUZZLE_FREE), me: Object.assign(Coach.me(cur.seat.ck, Coach.PUZZLE_FREE), { plus: cur.plus }) });
  const puzzleOut = (cur, st) => (!cur.seat || !st ? st : { ...st, hintFrom: cur.hintAt === cur.done.length ? st.hintFrom : null, coach: puzzleCoach(cur) });
  on("puzzle", ({ daily, rating, seen, plus, caps, coach, playerId } = {}) => {
    if (!daily && plus !== true) return refuse(socket, "plus", "More puzzles come with GameNest Plus. Today's is free.", "puzzle");
    // DAILY_PUZZLE: a test-only day's puzzle by its id (one with a long line), never set in production.
    const pick = daily ? (process.env.DAILY_PUZZLE && Puzzles.BY_ID.get(process.env.DAILY_PUZZLE)) || Puzzles.daily() : Puzzles.near(Number(rating), seen);
    const cur = socket.data.puzzle = { id: pick.id, done: [], hinted: false, rated: false, daily: !!daily, rating: Number(rating), plus: plus === true, seat: null, hintAt: -1 };
    if (Coach.knows(caps)) cur.seat = puzzleSeat(playerId, pick.id, caps, coach, "sock:" + socket.id);
    sendPuzzle(puzzleOut(cur, Puzzles.step(pick, [])), { daily: !!daily });
  });
  on("puzzleMove", ({ uci } = {}) => {
    const cur = socket.data.puzzle;
    const pz = cur && Puzzles.BY_ID.get(cur.id);
    if (!pz || typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return;
    const st = Puzzles.step(pz, cur.done, uci);
    if (!st) return;
    let delta = null;
    if (st.status === "wrong" || st.status === "solved") {
      // The first try counts for the puzzle rating; a hint used makes a solve worth nothing.
      if (!cur.rated) { cur.rated = true; delta = cur.hinted && st.status === "solved" ? 0 : Puzzles.rated(cur.rating, pz.rating, st.status === "solved"); }
    }
    if (st.status !== "wrong") cur.done.push(uci);
    sendPuzzle(puzzleOut(cur, st), { daily: cur.daily, ratingDelta: delta, tried: uci });
  });
  on("puzzleHint", () => {
    const cur = socket.data.puzzle;
    const pz = cur && Puzzles.BY_ID.get(cur.id);
    if (!pz) return;
    const st = Puzzles.step(pz, cur.done);
    if (cur.seat) {
      if (!st || st.status !== "playing") return;   // nothing to hint at
      const at = cur.done.length;
      if (cur.hintAt !== at && !cur.seat.hinted.has(at)) {   // a move's hint is counted once, however often the puzzle is opened
        const got = Coach.use(cur.seat.ck, "hint", cur.plus, Coach.PUZZLE_FREE);
        if (!got) return refuse(socket, "coach", Coach.LINES.hint, "puzzleHint");
        cur.seat.hinted.add(at);
        if (got.paid) socket.emit("coachUsed", { kind: "hint", left: got.left, game: cur.seat.game, puzzle: cur.id });
      }
      cur.hintAt = at;
    }
    cur.hinted = true;
    sendPuzzle(puzzleOut(cur, st), { daily: cur.daily, hint: true });
  });
  /* The app bought (or spent elsewhere): its whole stock again, with `seen`. In a room it is the seat's (or the waiting
     line's entry's); outside one it is the stock of the puzzle in hand. */
  on("coachStock", (payload) => {
    const room = currentRoom();
    if (room) {
      const p = room.players.find((q) => q.id === socket.data.playerId);
      if (p && !p.bot && p.ck) { if (Coach.take(p.ck, payload, room.gameId)) bump(room); return; }
      const w = (room.waiting || []).find((q) => q.id === socket.data.playerId);
      if (w && Coach.knows(w.caps)) w.coach = Coach.clean(payload);
      return;
    }
    const cur = socket.data.puzzle;
    if (cur && cur.seat && Coach.take(cur.seat.ck, payload, cur.seat.game)) socket.emit("puzzleCoach", { id: cur.id, coach: puzzleCoach(cur) });
  });
  /* GameNest Plus's analysis board, outside any room: a position of one's own (socket.data.analysis), moved for both
     sides, taken back, set up by hand; after each change "analysis" says how it stands, and, with the engine on,
     "analysisLines" brings Stockfish's three best lines for that position (a newer position drops an older answer). */
  const sendAnalysis = (extra) => {
    const a = socket.data.analysis;
    if (!a) return;
    const v = Analysis.view(a);
    socket.emit("analysis", { ...v, ...(extra || {}), serverNow: Date.now() });
    if (!a.engine || v.over) return;
    askLines(a);
  };
  /* One search in flight per player: moves made meanwhile wait, and the newest position is the one searched next
     (twelve players making quick moves queued every position they passed: a load test waited over 30 s). */
  const askLines = (a) => {
    if (a.busy) { a.again = true; return; }
    const fen = a.chess.fen();
    const turn = a.chess.turn();
    a.busy = true;
    SfBot.analyse(fen, { lines: 3, movetimeMs: ANALYSIS_MS }).then((lines) => {
      a.busy = false;
      const current = socket.data.analysis === a;
      if (current && a.engine && a.chess.fen() === fen && Array.isArray(lines)) {
        // Scores for White (the bar's side): Stockfish scores for the side to move.
        const sign = turn === "w" ? 1 : -1;
        socket.emit("analysisLines", { fen, lines: lines.map((l) => ({ ...l, score: l.score * sign })) });
      }
      if (a.again) {
        a.again = false;
        if (current && a.engine && a.chess.fen() !== fen && !Analysis.view(a).over) askLines(a);
      }
    });
  };
  on("analysis", ({ plus, fen } = {}) => {
    if (plus !== true) return refuse(socket, "plus", "The analysis board comes with GameNest Plus.", "analysis");
    socket.data.analysis = Analysis.open(fen);
    sendAnalysis();
  });
  on("analysisMove", ({ uci } = {}) => {
    const a = socket.data.analysis;
    if (!a || typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return;
    if (Analysis.move(a, uci)) sendAnalysis({ tried: uci });
  });
  on("analysisUndo", () => {
    const a = socket.data.analysis;
    if (a && Analysis.undo(a)) sendAnalysis();
  });
  on("analysisSetup", ({ board, turn } = {}) => {
    const a = socket.data.analysis;
    if (!a) return;
    const why = Analysis.setup(a, board, turn);
    if (why) return refuse(socket, "setup", why, "analysis");
    sendAnalysis();
  });
  on("analysisEngine", ({ on: want } = {}) => {
    const a = socket.data.analysis;
    if (!a || typeof want !== "boolean") return;
    a.engine = want;
    sendAnalysis();
  });
  on("analysisLeave", () => { socket.data.analysis = null; });

  /* Offers: a draw or a take-back, asked of the other seat (the bot answers at once). */
  on("offer", ({ kind } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || !room.chess || room.offer) return;
    if (kind !== "draw" && kind !== "takeback") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0 || room.players[seat].left) return;
    const other = activeSeats(room).find((x) => x !== seat);
    if (other === undefined) return;
    if (kind === "takeback" && !takebackPlies(room, seat)) return;
    const blocked = room.offerBlock && room.offerBlock[seat + kind];
    if (blocked !== undefined && plies(room) <= blocked) return;   // asked and refused: a move first
    /* The coach's stock (2026-11-13): a take-back the coach grants an app that knows the stock is one free a game, then
       one of the stock, or Plus. One a person grants is theirs to give: nothing is counted. */
    const asker = room.players[seat];
    if (kind === "takeback" && room.players[other].bot && asker.ck && asker.ck.knows) {
      const got = Coach.use(asker.ck, "takeback", asker.plus === true);
      if (!got) return refuse(socket, "coach", Coach.LINES.takeback, "offer");
      room.helped = true;
      if (got.paid) socket.emit("coachUsed", { kind: "takeback", left: got.left, game: room.gameId });
    }
    if (humanIsBack(room, room.players[seat], "took the seat back")) { /* state sent below */ }
    room.offer = { kind, from: seat };
    room.log = `${room.players[seat].name} ${kind === "draw" ? "offers a draw" : "asks to take back a move"}.`;
    if (room.players[other].bot) {
      const yes = botAnswers(room, other);
      settleOffer(room, yes);
      if (!yes) room.log = `The coach declines the ${kind === "draw" ? "draw" : "take-back"}.`;
    }
    bump(room);
  });
  on("reply", ({ accept } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || !room.offer || typeof accept !== "boolean") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0 || seat === room.offer.from || room.players[seat].left) return;
    settleOffer(room, accept);
    bump(room);
  });
  on("cancelOffer", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || !room.offer) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0 || seat !== room.offer.from) return;
    const kind = room.offer.kind;
    room.offer = null;
    room.offerBlock = room.offerBlock || {};
    room.offerBlock[seat + kind] = plies(room);
    room.log = `${room.players[seat].name} withdrew the offer.`;
    bump(room);
  });
  on("resign", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0 || room.players[seat].left) return;
    const other = activeSeats(room).find((x) => x !== seat);
    finish(room, other === undefined ? null : other, "resign");
    room.log = `${room.players[seat].name} resigned.`;
    bump(room);
  });
  on("takeSeat", () => {
    const room = currentRoom(); if (!room) return;
    const self = room.players.find((q) => q.id === socket.data.playerId);
    if (self && humanIsBack(room, self, "took the seat back")) bump(room);
  });
  on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
  on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


  on("chat", ({ t } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || me.left) return;
    const now = Date.now();
    if (me._lastChat && now - me._lastChat < 700) return;
    me._lastChat = now;
    t = clean(t, 140); if (!t) return;
    const code = room.code, pid = me.id;
    Moderation.chat(t).then((shown) => {
      const room = rooms.get(code), me = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!me || me.left) return;
      room.chat.push({ n: me.name, a: me.avatar, t: shown }); for (const q of room.players) if (q !== me) pushTo(q, me.name + ": " + shown, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
      if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
      bump(room);
    });
  });

  on("voice", ({ kind, to, data } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;
    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat); else room.voice.delete(seat);
      bump(room); return;
    }
    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0; try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const socks = roomSockets.get(room.code);
      if (!socks) return;
      for (const s of socks) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((p) => !p.left);
    seatTheLine(room);
    if (room.players.filter((p) => !p.bot).length === 0) { deleteRoom(room.code); return; }
    if (room.players.length < MIN_PLAYERS) { room.status = "lobby"; room.log = "Back to the lobby."; bump(room); return; }
    setupGame(room);
    bump(room);
  });

  function handleLeave() {
    const room = currentRoom();
    if (!room) return detach();
    const p = room.players.find((q) => q.id === (socket.data.as || socket.data.playerId));
    if (!p) {
      // Out of the waiting line.
      const before = (room.waiting || []).length;
      room.waiting = (room.waiting || []).filter((w) => w.id !== socket.data.playerId);
      detach();
      if (room.waiting.length !== before) bump(room);
      return;
    }
    if (room.voice) room.voice.delete(room.players.indexOf(p));
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q.id !== p.id);
      if (room.players.length === 0 || room.players.every((q) => q.bot)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
      room.log = `${p.name} left.`;
    } else {
      const seat = room.players.indexOf(p);
      p.left = true; p.connected = false;
      // The first in line takes the seat before anything is decided for want of players.
      const taken = takeLeftSeats(room);
      if (room.players.every((q) => q.bot || q.left)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot && !q.left) || room.players[0]).id;
      if (!taken) room.log = `${p.name} left the game.`;
      if (room.status === "playing") {
        const act = activeSeats(room);
        if (act.length === 1) {
          finish(room, act[0], "left");
          room.log = `${room.players[act[0]].name} is the last one at the board — they win!`;
        } else if (room.turn === seat) { nextTurn(room); armTimer(room.code); }
      }
    }
    detach();
    bump(room);
  }
  on("leave", () => handleLeave());
  socket.on("disconnect", () => { if (currentRoom()) awayFromRoom(); });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > 2 * 60 * 60 * 1000) deleteRoom(code);
}, 10 * 60 * 1000).unref();   // the listening server keeps the process up; a test that only requires this file can exit

/* A promise nobody caught must not stop every room with it (Node ends the process on one): it is logged, and the rooms carry on. */
if (require.main === module) {
  process.on("unhandledRejection", (e) => console.error(`[${new Date().toISOString()}] unhandled rejection:`, (e && e.stack) || e));
  server.listen(PORT, () => {
    console.log("Chess running on port " + PORT);
    if (!process.env.NO_WARM) MaiaBot.warm().then((ok) => { if (ok) console.log("Maia-2 warm"); }, () => {});   // the model loads before the first game needs it
  });
}
module.exports = { applyMove, botCol, capName, capAvatar, FEATURES, rooms, thinkMs, botStats, Coach, coachView, puzzleSeat, puzzleSeats };
