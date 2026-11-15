/* Bot pacing (pacing round 1, 2026-11-01): a bot's ply takes 0.8-2.5 s by the position and is never over 3 s, whatever its
   engine does. The think-time model; the watchdog, with an engine that hangs, rejects, throws, answers an illegal move or
   answers late; the Maia worker's supervision (a wedged run is replaced; a review gives way to a bot). Own servers on
   TEST_PORT.. (default 5443, six ports); never 3111-3124. */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const G = require("../game");
const Maia = require("../maia");

const PORT = Number(process.env.TEST_PORT || 5443);
if (PORT >= 3111 && PORT <= 3124) { console.error("refusing " + PORT + ": the live servers"); process.exit(2); }
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("  ok " + name); };
const play = (sans) => { const c = new G.Chess(); for (const s of sans) c.move(s); return c; };

(async () => {
  const srv = require("../server");   // not listening: required, not run
  console.log("pacing: how long a bot thinks");
  const think = (c, extra) => srv.thinkMs(Object.assign({ chess: c, level: "normal", white: 0 }, extra));
  await ok("a forced move is quick (0.8-0.95 s)", () => {
    const c = new G.Chess("4k3/8/8/8/8/8/5q2/4K2r w - - 0 1");   // White's king has exactly one move
    assert.strictEqual(c.moves().length, 1, c.moves().join(" "));
    for (let i = 0; i < 40; i++) { const ms = think(c); assert.ok(ms >= 800 && ms <= 950, "" + ms); }
  });
  await ok("a recapture is quick (under 1.3 s)", () => {
    const c = play(["e4", "d5", "exd5"]);   // Black takes back: Qxd5 or Nxd5
    for (let i = 0; i < 40; i++) { const ms = think(c); assert.ok(ms >= 800 && ms <= 1300, "" + ms); }
  });
  await ok("a crowded middlegame takes longer than the opening (and never over 2.5 s)", () => {
    const open = play(["e4"]);
    const mid = new G.Chess("r2q1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 9");
    assert.ok(mid.moves({ verbose: true }).length >= 30);
    let a = 0, b = 0;
    for (let i = 0; i < 60; i++) { const x = think(open), y = think(mid); assert.ok(y <= 2500 && x <= 1300, `${x} ${y}`); a += x; b += y; }
    assert.ok(b / 60 > a / 60 + 300, `opening ${a / 60} vs middlegame ${b / 60}`);
  });
  await ok("over 300 positions of random games it stays in 0.8-2.5 s and varies", () => {
    const seen = new Set();
    let lo = 1e9, hi = 0;
    for (let g = 0; g < 8; g++) {
      const c = new G.Chess();
      for (let ply = 0; ply < 80 && !c.isGameOver(); ply++) {
        const ms = think(c); lo = Math.min(lo, ms); hi = Math.max(hi, ms); seen.add(Math.floor(ms / 250));
        const m = c.moves(); c.move(m[Math.floor(Math.random() * m.length)]);
      }
    }
    assert.ok(lo >= 800 && hi <= 2500, `${lo}..${hi}`);
    assert.ok(seen.size >= 4, "think times fall in " + seen.size + " bands of 250 ms");
  });
  await ok("short of time on a clock, it does not think long", () => {
    const mid = new G.Chess("r2q1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 9");
    for (let i = 0; i < 30; i++) assert.ok(think(mid, { clock: { w: 12000, b: 12000 } }) <= 800);
  });

  console.log("pacing: the watchdog (an engine that misbehaves; the move comes within 3 s)");
  const client = (port) => io(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true });
  const scenario = async (mode, port, check) => {
    const child = spawn(process.execPath, ["-r", path.join(__dirname, "stub_engine.js"), path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: port, STUB: mode, START_WHITE: "host", AFK_MS: "60000", NO_WARM: "1" }), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 900));
    const a = client(port);
    let last = null;
    const waiters = [];
    a.on("state", (st) => { last = st; for (const w of waiters.slice()) w(st); });
    const until = (pred, ms = 6000) => new Promise((res, rej) => {
      if (last && pred(last)) return res(last);
      const t = setTimeout(() => rej(new Error(`${mode}: no matching state in ${ms} ms`)), ms);
      const w = (st) => { if (pred(st)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); res(st); } };
      waiters.push(w);
    });
    try {
      a.emit("create", { name: "Ava", playerId: "p_pace_" + mode });
      await until((s) => s.room.players.length === 1);
      a.emit("settings", { level: "normal", tc: "none" });
      await until((s) => s.room.level === "normal");
      a.emit("addBot");
      await until((s) => s.room.players.length === 2);
      a.emit("start");
      await until((s) => s.room.status === "playing" && s.room.turn === s.mySeat);
      a.emit("move", { uci: "e2e4" });
      const t0 = Date.now();
      const st = await until((s) => s.room.lastMove && s.room.lastMove.mv >= 2);
      const ms = Date.now() - t0;
      await check(st, ms);
    } finally { a.close(); child.kill(); }
  };
  const within3s = (name, extra) => async (st, ms) => {
    assert.ok(ms < 3000, `${name}: the bot took ${ms} ms`);
    const m = st.room.lastMove;
    assert.ok(m && m.seat !== st.mySeat, "the bot moved");
    if (extra) extra(st, ms);
    return ms;
  };
  const times = {};
  for (const [i, mode] of ["hang", "reject", "throw", "illegal", "late", "slow"].entries()) {
    await ok(`an engine that ${mode === "hang" ? "never answers" : mode === "reject" ? "rejects" : mode === "throw" ? "throws" : mode === "illegal" ? "answers an illegal move" : mode === "late" ? "answers after 3.5 s" : "answers in 1 s"}: the bot still moves in under 3 s`, () =>
      scenario(mode, PORT + i, async (st, ms) => { times[mode] = ms; await within3s(mode, mode === "slow" ? (s) => assert.strictEqual(s.room.lastMove.from + s.room.lastMove.to, "e7e5", "the engine's move, as it was in time") : null)(st, ms); }));
  }
  console.log("    (ms to the bot's move: " + Object.entries(times).map(([k, v]) => `${k} ${v}`).join(", ") + ")");

  if (Maia.available()) {
    console.log("pacing: the Maia worker");
    const ask = (stall, ms) => Maia._ask({ kind: "chances", fen: new G.Chess().fen(), legal: G.legalMoves(new G.Chess()), elo: 1400, oppoElo: 1400, stall }, ms);
    await ok("a wedged model run costs two timeouts, then the worker is replaced and the next bot move comes at once", async () => {
      await Maia.move(new G.Chess(), { elo: 1400 });   // loaded
      assert.ok(Maia._alive());
      assert.strictEqual(await ask(true, 250), null);
      assert.ok(Maia._alive(), "one silence is not yet a wedge");
      assert.strictEqual(await ask(true, 250), null);
      assert.ok(!Maia._alive(), "two silences running replace the worker");
      const t = Date.now();
      const mv = await Maia.move(new G.Chess(), { elo: 1400 });
      assert.ok(G.legalMoves(new G.Chess()).includes(mv), "a move from the new worker: " + mv);
      assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
    });
    await ok("a game review does not hold a bot's move (it gives way between plies)", async () => {
      const c = new G.Chess(), moves = [];
      while (!c.isGameOver() && moves.length < 160) { const m = c.moves({ verbose: true }); const x = m[Math.floor(Math.random() * m.length)]; c.move(x); moves.push(x.lan); }
      await Maia.move(new G.Chess(), { elo: 1400 });
      const review = Maia.rate(moves);
      const waits = [];
      for (let i = 0; i < 12; i++) { const t = Date.now(); await Maia.move(new G.Chess(), { elo: 1400 }); waits.push(Date.now() - t); await new Promise((r) => setTimeout(r, 30)); }
      await review;
      const worst = Math.max(...waits);
      assert.ok(worst < 400, `a bot's move waited ${worst} ms behind a review of ${moves.length} plies (${waits.join(" ")})`);
    });
  } else console.log("  (skipped the Maia worker's tests: no engine/maia2_rapid.onnx)");

  console.log(`${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
