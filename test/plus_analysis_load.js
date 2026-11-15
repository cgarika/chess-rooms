/* Chess: the analysis board under load (2026-10-17): twelve players at once, each making six quick moves; every one
   gets the engine's lines for the position they end on, and soon, however many searches the moves before it asked
   for. One Stockfish worker serves the whole server, so a search a player has already moved past must not hold up
   everyone else's. */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const Sf = require("../sf");

const PORT = Number(process.env.TEST_PORT || 3297);
const URL = `http://127.0.0.1:${PORT}`;
const PLAYERS = 12;
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wait(fn, ms) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timeout")); setTimeout(tick, 15); };
    tick();
  });
}

async function main() {
  if (!Sf.available()) { console.log("plus analysis load: no Stockfish here, skipped"); process.exit(0); }
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  const socks = [];
  try {
    await sleep(1500);
    const players = [];
    for (let i = 0; i < PLAYERS; i++) {
      const s = io(URL, { transports: ["websocket"], forceNew: true });
      const p = { s, st: null, lines: new Map(), asked: 0 };
      s.on("analysis", (m) => { p.st = m; });
      s.on("analysisLines", (m) => { p.lines.set(m.fen, m); });
      socks.push(s);
      players.push(p);
    }
    await wait(() => players.every((p) => p.s.connected), 5000);
    players.forEach((p) => p.s.emit("analysis", { plus: true }));
    await wait(() => players.every((p) => p.st && p.st.legal.length === 20), 5000);
    const t0 = Date.now();
    for (const u of LINE) {
      players.forEach((p) => p.s.emit("analysisMove", { uci: u }));
      await sleep(60);
    }
    await wait(() => players.every((p) => p.st && p.st.sans.length === LINE.length), 5000);
    const ends = await wait(() => {
      const done = players.map((p) => p.lines.get(p.st.fen));
      return done.every(Boolean) && done;
    }, 30000);
    const took = Date.now() - t0;
    assert.ok(ends.every((e) => e.lines.length === 3), "three lines each");
    console.log(`  ok ${PLAYERS} players, ${LINE.length} quick moves each: every one has its final position's lines in ${took} ms`);
    // Lines for positions left behind are fine to drop; what matters is how long the last ones took.
    assert.ok(took < 12000, `the final lines came within 12 s (${took} ms)`);
    console.log("  ok within 12 s");
  } finally {
    socks.forEach((s) => s.close());
    srv.kill();
  }
  console.log("plus analysis load: passed");
  process.exit(0);
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
