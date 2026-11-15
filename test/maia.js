/* The free bots as people (maia.js): the position as Maia-2 sees it, its chances against the Python package's own
   (maia2 0.11.0, rapid), and the Easy, Normal and Hard bots playing its moves over a real socket — or the old way,
   with no model. Without engine/maia2_rapid.onnx (tools/maia_model.sh) the model's tests are skipped. */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const Maia = require("../maia");
const G = require("../game");

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("  ok " + name); };

// Each: the position, the mover's rating, the opponent's, and the Python package's two likeliest moves.
const REFERENCE = [
  ["4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1", 900, 1000, [["b7b8q", 0.6504], ["e1f2", 0.3329]]],
  ["4k3/1P6/8/8/8/8/6p1/4K3 b - - 0 1", 1150, 1500, [["g2g1q", 0.9724], ["e8d8", 0.013]]],
  ["r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1", 1350, 2100, [["e8g8", 0.5576], ["e8c8", 0.2797]]],
  ["rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", 1550, 1000, [["e5f6", 0.3075], ["d2d4", 0.2414]]],
  ["rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 3", 1750, 1500, [["d7d5", 0.5544], ["e4d3", 0.2488]]],
];

(async () => {
  console.log("maia: the position");
  await ok("ratings fall in Maia-2's bands (under 1100, each 100 to 2000, 2000 up)", () => {
    assert.deepStrictEqual([800, 1099, 1100, 1199, 1500, 1999, 2000, 2800].map(Maia.eloBand), [0, 0, 1, 1, 5, 9, 10, 10]);
  });
  await ok("Black to move is White to move on the board flipped, colours swapped", () => {
    const b = Maia.encode("r3k2r/pppppppp/8/8/3Pp3/8/PPP1PPPP/R3K2R b Kq d3 0 1");
    const w = Maia.encode("r3k2r/ppp1pppp/8/3pP3/8/8/PPPPPPPP/R3K2R w Qk d6 0 1");
    assert.ok(b.black && !w.black);
    assert.deepStrictEqual(Array.from(b.x), Array.from(w.x));
  });
  await ok("moves flip with the board", () => {
    assert.strictEqual(Maia.mirrorMove("e7e5"), "e2e4");
    assert.strictEqual(Maia.mirrorMove("g2g1q"), "g7g8q");
  });
  await ok("temp 0 plays its first choice; a move under 2% is never played", () => {
    const probs = [{ uci: "a", p: 0.6 }, { uci: "b", p: 0.39 }, { uci: "c", p: 0.01 }];
    assert.strictEqual(Maia.pick(probs, 0), "a");
    for (let i = 0; i < 200; i++) assert.notStrictEqual(Maia.pick(probs, 1), "c");
    assert.strictEqual(Maia.pick(probs, 1, () => 0.999), "b");
  });

  if (!Maia.available()) {
    console.log("  (skipped: no engine/maia2_rapid.onnx; tools/maia_model.sh makes it)");
    console.log(`${passed} passed`);
    process.exit(0);
  }

  console.log("maia: the model");
  await ok("its chances are the Python package's (promotions, castling, en passant, both sides)", async () => {
    for (const [fen, elo, oppoElo, want] of REFERENCE) {
      const probs = await Maia.chances(fen, G.legalMoves(new G.Chess(fen)), { elo, oppoElo });
      assert.ok(probs, fen);
      want.forEach(([uci, p], i) => {
        assert.strictEqual(probs[i].uci, uci, fen);
        assert.ok(Math.abs(probs[i].p - p) < 0.0005, `${fen} ${uci} ${probs[i].p} vs ${p}`);
      });
      assert.ok(Math.abs(probs.reduce((a, m) => a + m.p, 0) - 1) < 1e-4);
    }
  });
  await ok("a move takes well under 50 ms once loaded", async () => {
    const legal = G.legalMoves(new G.Chess());
    await Maia.move(new G.Chess(), { elo: 1400 });
    const t = Date.now();
    for (let i = 0; i < 20; i++) assert.ok(legal.includes(await Maia.move(new G.Chess(), { elo: 1400 })));
    assert.ok((Date.now() - t) / 20 < 50, `${(Date.now() - t) / 20} ms a move`);
  });

  await ok("a bot never takes its move back, nor repeats a position, while it has a fresh move (Maia-2 likes Ng8 after e3 Nf6 Be2)", async () => {
    const c = new G.Chess();
    for (const m of ["e2e3", "g8f6", "f1e2"]) c.move(m);
    assert.deepStrictEqual(Maia.repeating(c), ["f6g8"]);
    const p = await Maia.chances(c.fen(), G.legalMoves(c), { elo: 1950 });
    assert.strictEqual(p[0].uci, "f6g8");   // what the model would play
    for (let i = 0; i < 10; i++) assert.notStrictEqual(await Maia.move(c, { elo: 1950, temp: 1 }), "f6g8");
    c.move("g7g6"); c.move("e2f1");   // White takes its bishop back: Bg7 is fresh, Ng8... and the start's position again
    assert.ok(!Maia.repeating(c).includes("f8g7"));
    c.move("f8g7"); c.move("f1e2"); c.move("g7f8");
    assert.ok(Maia.repeating(c).includes("e2f1"));   // a position the game has had
  });
  await ok("a whole game's ratings: each side's, from its moves (null for a side with too few)", async () => {
    const r = await Maia.rate(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5",
      "a4b3", "d7d6", "c2c3", "e8g8", "h2h3", "c6a5", "b3c2", "c7c5"]);
    for (const side of ["w", "b"]) {
      assert.ok(r[side] && r[side].moves === 10 && r[side].elo >= 1000 && r[side].elo <= 2100, JSON.stringify(r));
    }
    const short = await Maia.rate(["e2e4", "e7e5", "g1f3"]);
    assert.deepStrictEqual(short, { w: null, b: null });
  });

  console.log("maia: the rooms");
  const PORT = Number(process.env.TEST_PORT || 3296);
  const uciOf = (lm) => lm.from + lm.to + (lm.promotion || "");
  // A game against the bot at a level; each of the bot's moves is checked against Maia-2's chances (2% or more).
  async function game(port, level, env, check) {
    const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: port, BOT_MS: "5", AFK_MS: "60000" }, env), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 900));
    const a = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true });
    const next = (pred, ms = 8000) => new Promise((res, rej) => {
      const t = setTimeout(() => { a.off("state", on); rej(new Error("no matching state")); }, ms);
      const on = (st) => { if (pred(st)) { clearTimeout(t); a.off("state", on); res(st); } };
      a.on("state", on);
    });
    try {
      a.emit("create", { name: "Ava", playerId: "p_ava_maia" });
      await next((s) => s.room.players.length === 1);
      a.emit("settings", { level, tc: "none" });
      await next((s) => s.room.level === level);
      a.emit("addBot");
      await next((s) => s.room.players.length === 2);
      a.emit("start");
      let st = await next((s) => s.room.status === "playing");
      let botMoves = 0;
      const seen = new G.Chess(st.room.fen);   // the game as the app sees it, move by move
      while (st.room.status === "playing" && botMoves < 12) {
        if (st.room.turn === st.mySeat) {
          const legal = st.room.legal;
          const uci = legal[Math.floor(Math.random() * legal.length)];
          a.emit("move", { uci });
          st = await next((s) => s.room.status !== "playing" || s.room.turn !== s.mySeat);
          seen.move(uci);
        } else {
          st = await next((s) => s.room.status !== "playing" || s.room.turn === s.mySeat);
          if (st.room.lastMove && st.room.status === "playing") {
            await check(seen, uciOf(st.room.lastMove));
            seen.move(uciOf(st.room.lastMove));
            botMoves++;
          }
        }
      }
      assert.ok(botMoves >= 2, `the bot moved ${botMoves} times`);   // a random mover can be mated in four moves (it was six here and failed now and then): the test is about the moves the bot chose, however few it got to make
    } finally { a.close(); srv.kill(); }
  }
    for (const [i, level, elo] of [[0, "easy", 1000], [1, "normal", 1400], [2, "hard", 1900]]) {
    await ok(`${level}: the bot plays Maia-2's moves at ${elo}, never a repeat it could avoid`, () => game(PORT + i, level, {}, async (c, uci) => {
      const rep = new Set(Maia.repeating(c));
      const probs = (await Maia.chances(c.fen(), G.legalMoves(c), { elo })).filter((m) => !rep.has(m.uci) || rep.size === G.legalMoves(c).length);
      const tot = probs.reduce((a, m) => a + m.p, 0);
      const keep = probs.filter((m) => m.p / tot >= 0.02).map((m) => m.uci);
      assert.ok(keep.includes(uci), `${c.fen()}: ${uci} not among ${keep.join(" ")}`);
    }));
  }
  await ok("a Plus room's review carries how each side played, as a rating", async () => {
    const port = PORT + 4;
    const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: port, BOT_MS: "5", AFK_MS: "60000", REVIEW_MS: "40" }), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 900));
    const a = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true });
    let last = null;
    a.on("state", (st) => { last = st; });
    const until = async (pred, ms = 20000) => { const t = Date.now(); while (!(last && pred(last))) { if (Date.now() - t > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } return last; };
    try {
      a.emit("create", { name: "Ava", playerId: "p_ava_rate", plus: true });
      await until((s) => s.room.players.length === 1);
      a.emit("settings", { level: "normal", tc: "none" });
      a.emit("addBot");
      await until((s) => s.room.players.length === 2);
      a.emit("start");
      await until((s) => s.room.status === "playing");
      while (last.room.status === "playing" && last.room.moves.length < 30) {
        const st = await until((s) => s.room.status !== "playing" || s.room.turn === s.mySeat);
        if (st.room.status !== "playing") break;
        const n = st.room.moves.length;
        a.emit("move", { uci: st.room.legal[Math.floor(Math.random() * st.room.legal.length)] });
        await until((s) => s.room.status !== "playing" || s.room.moves.length > n);
      }
      if (last.room.status === "playing") { a.emit("resign"); await until((s) => s.room.status === "over"); }
      a.emit("review");
      const st = await until((s) => s.room.review && s.room.review.status === "done" && s.room.review.rating, 40000);
      for (const side of ["w", "b"]) {
        const r = st.room.review.rating[side];
        assert.ok(r && r.elo >= 1000 && r.elo <= 2100 && r.moves >= 8, JSON.stringify(st.room.review.rating));
      }
    } finally { a.close(); srv.kill(); }
  });
  await ok("with no model the bot still plays (the old way)", () => game(PORT + 3, "normal", { MAIA_MODEL: "/nonexistent/maia.onnx" }, async (c, uci) => {
    assert.ok(G.legalMoves(c).includes(uci));
  }));

  console.log(`${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
