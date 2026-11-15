/* Chess: GameNest Plus's analysis board, on its own and over real sockets (2026-10-17). */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const Analysis = require("../analysis");
const Sf = require("../sf");

const PORT = Number(process.env.TEST_PORT || 3296);
const URL = `http://127.0.0.1:${PORT}`;
let passed = 0;
const ok = (name) => { passed++; console.log("  ok " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wait(fn, ms = 10000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timeout")); setTimeout(tick, 15); };
    tick();
  });
}
const empty = () => Array.from({ length: 8 }, () => Array(8).fill(""));
const put = (b, sq, p) => { b[Number(sq[1]) - 1]["abcdefgh".indexOf(sq[0])] = p; return b; };

async function main() {
  console.log("plus analysis: the module");
  const a = Analysis.open();
  assert.strictEqual(Analysis.view(a).legal.length, 20);
  assert.ok(Analysis.move(a, "e2e4") && Analysis.move(a, "e7e5"));
  assert.ok(!Analysis.move(a, "e1e3"));
  let v = Analysis.view(a);
  assert.deepStrictEqual(v.sans, ["e4", "e5"]);
  assert.strictEqual(v.lastMove, "e7e5");
  assert.ok(v.canUndo);
  ok("moves for both sides, an illegal one refused");
  assert.ok(Analysis.undo(a) && Analysis.undo(a) && !Analysis.undo(a));
  assert.strictEqual(Analysis.view(a).fen, Analysis.START);
  ok("taken back to the start, and no further");
  assert.strictEqual(Analysis.open("not a fen").root, Analysis.START);
  ok("a bad FEN opens the start");
  // Set-ups.
  let b = put(put(put(empty(), "e1", "wK"), "e8", "bK"), "a1", "wR");
  put(b, "h1", "wR");
  assert.strictEqual(Analysis.setup(a, b, "w"), null);
  assert.ok(Analysis.view(a).fen.includes(" w KQ - "), Analysis.view(a).fen);
  ok("a hand-made position, castling where king and rooks stand at home");
  assert.match(Analysis.setup(a, put(empty(), "e1", "wK"), "w"), /one king/);
  assert.match(Analysis.setup(a, put(put(put(empty(), "e1", "wK"), "e8", "bK"), "a8", "wP"), "w"), /first or last/);
  assert.match(Analysis.setup(a, put(put(put(empty(), "e1", "wK"), "e8", "bK"), "e4", "wR"), "w"), /not moving is in check/);
  assert.match(Analysis.setup(a, put(put(empty(), "e1", "wK"), "e8", "bK"), "x"), /who moves/);
  ok("set-ups refused: one king each, pawns, the side not moving in check, whose move");
  assert.ok(Analysis.view(a).fen.includes(" w KQ - "));
  ok("a refused set-up leaves the board as it was");

  if (!Sf.available()) { console.log("  (no Stockfish here: the socket part skipped)"); console.log(`plus analysis: all ${passed} passed`); process.exit(0); }
  console.log("plus analysis: over sockets");
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(PORT), ANALYSIS_MS: "300" }, stdio: "ignore" });
  const s = io(URL, { transports: ["websocket"], forceNew: true });
  try {
    await wait(() => s.connected);
    let st = null, lines = [], refusal = null;
    s.on("analysis", (m) => { st = m; });
    s.on("analysisLines", (m) => { lines.push(m); });
    s.on("refusal", (m) => { refusal = m; });
    s.emit("analysis", {});
    await wait(() => refusal);
    assert.strictEqual(refusal.code, "plus");
    assert.strictEqual(st, null);
    ok("without Plus: refused, code plus");
    s.emit("analysis", { plus: true });
    await wait(() => st && st.legal.length === 20);
    const first = await wait(() => lines.find((l) => l.fen === st.fen));
    assert.strictEqual(first.lines.length, 3);
    assert.ok(first.lines.every((l) => /^[a-h][1-8][a-h][1-8]/.test(l.uci) && l.pv.length >= 1 && Math.abs(l.score) < 200), JSON.stringify(first.lines));
    assert.ok(first.lines[0].score >= first.lines[2].score);
    ok("the start: three lines, best first, about level (" + first.lines.map((l) => l.san + " " + l.score).join(", ") + ")");
    // Scholar's mate set up: White to play Qxf7#.
    for (const u of ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"]) { s.emit("analysisMove", { uci: u }); await wait(() => st.lastMove === u); }
    const mate = await wait(() => lines.find((l) => l.fen === st.fen));
    assert.strictEqual(mate.lines[0].san, "Qxf7#");
    assert.ok(mate.lines[0].score > 90000);
    ok("White to mate: Qxf7# first, scored as a mate for White");
    s.emit("analysisMove", { uci: "e7e6" });   // Black's pawn is gone from e7 now... not legal: nothing happens
    await sleep(300);
    assert.strictEqual(st.lastMove, "g8f6");
    s.emit("analysisUndo");
    await wait(() => st.lastMove === "d1h5");
    const black = await wait(() => lines.find((l) => l.fen === st.fen));
    assert.ok(black.lines[0].score > -300, "for White, Black to move after Qh5: " + black.lines[0].score);
    ok("taken back a move; Black to move, its lines scored for White");
    s.emit("analysisEngine", { on: false });
    await wait(() => st.engine === false);
    const before = lines.length;
    s.emit("analysisMove", { uci: "g7g6" });
    await wait(() => st.lastMove === "g7g6");
    await sleep(800);
    assert.strictEqual(lines.length, before);
    ok("the engine off: no lines");
    refusal = null;
    s.emit("analysisSetup", { board: put(empty(), "e1", "wK"), turn: "w" });
    await wait(() => refusal);
    assert.strictEqual(refusal.code, "setup");
    s.emit("analysisSetup", { board: put(put(put(empty(), "e1", "wK"), "e8", "bK"), "d1", "wQ"), turn: "w" });
    await wait(() => st.fen.startsWith("4k3/8/8/8/8/8/8/3QK3 w"));
    ok("set up by hand over the socket, a bad one refused");
  } finally {
    s.close();
    srv.kill();
  }
  console.log(`plus analysis: all ${passed} passed`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
