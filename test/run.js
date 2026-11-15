/* Chess: the rules as the room uses them, the bot, and whole games over a real socket. */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const G = require("../game");

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ok " + name); };
const play = (sans) => { const c = new G.Chess(); for (const s of sans) c.move(s); return c; };

console.log("rules");
ok("the board is rank 1 first, file a first", () => {
  const b = G.boardOf(new G.Chess());
  assert.strictEqual(b[0][0], "wR"); assert.strictEqual(b[0][4], "wK"); assert.strictEqual(b[7][3], "bQ"); assert.strictEqual(b[3][3], "");
});
ok("twenty legal opening moves, as e2e4", () => {
  const m = G.legalMoves(new G.Chess());
  assert.strictEqual(m.length, 20); assert.ok(m.includes("e2e4")); assert.ok(m.includes("g1f3"));
});
ok("fool's mate is checkmate, black wins", () => {
  assert.deepStrictEqual(G.outcome(play(["f3", "e5", "g4", "Qh4#"])), { reason: "checkmate", winner: "b" });
});
ok("stalemate is a draw", () => {
  const c = new G.Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.deepStrictEqual(G.outcome(c), { reason: "stalemate", winner: null });
});
ok("castling, en passant and promotion are legal moves", () => {
  const castle = new G.Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.ok(G.legalMoves(castle).includes("e1g1") && G.legalMoves(castle).includes("e1c1"));
  const ep = new G.Chess("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  assert.ok(G.legalMoves(ep).includes("e5d6"));
  const promo = new G.Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  assert.ok(G.legalMoves(promo).includes("a7a8q") && G.legalMoves(promo).includes("a7a8n"));
});

console.log("bot");
ok("it mates in one when it can", () => {
  const c = play(["f3", "e5", "g4"]);   // black to play Qh4#
  assert.strictEqual(G.botMove(c, 2), "d8h4");
});
ok("it takes a queen left hanging", () => {
  const c = new G.Chess("4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1");
  assert.strictEqual(G.botMove(c, 2), "e4d5");
});
ok("it thinks fast enough (depth 3 from the opening under 3 s)", () => {
  const t = Date.now();
  assert.ok(G.botMove(new G.Chess(), 3));
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

/* ---------- whole games over a socket ---------- */
const PORT = Number(process.env.TEST_PORT || 3292);
const URL = `http://127.0.0.1:${PORT}`;
const client = () => io(URL, { transports: ["websocket"], forceNew: true });
function nextState(sock, pred, ms = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { sock.off("state", on); rej(new Error("no matching state")); }, ms);
    const on = (st) => { if (!pred || pred(st)) { clearTimeout(t); sock.off("state", on); res(st); } };
    sock.on("state", on);
  });
}

async function games() {
  console.log("games");
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT, BOT_MS: "5", TURN_MS: "1500", AFK_MS: "300", BOT_DEPTH: "2" }), stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
  try {
    const a = client();
    a.emit("create", { name: "Ava", playerId: "p_ava" });
    let st = await nextState(a, (s) => s.room.players.length === 1);
    a.emit("settings", { level: "easy", tc: "none" });
    await nextState(a, (s) => s.room.level === "easy" && s.room.tc === "none");
    a.emit("addBot");
    await nextState(a, (s) => s.room.players.length === 2);
    a.emit("start");
    st = await nextState(a, (s) => s.room.status === "playing");
    assert.strictEqual(st.room.board.length, 8);
    assert.ok(st.room.white === 0 || st.room.white === 1);
    passed++; console.log("  ok a game starts with white to move, the board and the legal moves sent");

    // A hint on our turn names one of our legal moves; the move made clears it.
    if (st.room.turn !== st.mySeat) st = await nextState(a, (s) => s.room.turn === s.mySeat);
    a.emit("hint");
    st = await nextState(a, (s) => !!s.room.hint);
    assert.ok(st.room.legal.includes(st.room.hint.from + st.room.hint.to) || st.room.legal.some((m) => m.startsWith(st.room.hint.from + st.room.hint.to)));
    passed++; console.log("  ok a hint names one of our legal moves");

    // An illegal move, and one out of turn, change nothing.
    if (st.room.turn !== st.mySeat) st = await nextState(a, (s) => s.room.turn === s.mySeat);
    const fen = st.room.fen;
    a.emit("move", { uci: "e2e5" }); a.emit("move", { uci: "zz" }); a.emit("move", { from: "a1", to: "a8" });
    await new Promise((r) => setTimeout(r, 200));
    a.emit("move", { uci: st.room.legal[0] });
    st = await nextState(a, (s) => s.room.lastMove && s.room.lastMove.seat === s.mySeat);
    assert.notStrictEqual(st.room.fen, fen);
    passed++; console.log("  ok an illegal move is ignored; a legal one is played");

    // The rest of the game: our side plays the first legal move each time, to the end.
    let guard = 0, sawNoClock = false;
    while (st.room.status === "playing" && guard++ < 4000) {
      if (st.room.turn === st.mySeat) {
        sawNoClock = sawNoClock || st.room.phaseEndsAt === null;
        const mv = st.room.lastMove ? st.room.lastMove.mv : 0;
        a.emit("move", { uci: st.room.legal[0] });
        st = await nextState(a, (s) => s.room.status !== "playing" || (s.room.lastMove && s.room.lastMove.mv > mv));
      } else {
        st = await nextState(a, (s) => s.room.status !== "playing" || s.room.turn === s.mySeat, 15000);
      }
    }
    assert.strictEqual(st.room.status, "over");
    assert.ok(st.room.result && st.room.result.reason, "a finished game says why");
    passed++; console.log(`  ok a game against the bot plays to the end (${st.room.result.reason}, after ${st.room.lastMove.mv} moves)`);

    // Against a bot there is no clock on our move; the move list is sent.
    assert.ok(sawNoClock, "no clock on our move against a bot");
    assert.ok(Array.isArray(st.room.moves) && st.room.moves.length === st.room.lastMove.mv, "the move list is sent");
    assert.ok(Array.isArray(st.room.positions) && st.room.positions.length === st.room.moves.length + 1, "every position, the start first");
    assert.strictEqual(st.room.positions[0], "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
    passed++; console.log("  ok no clock against the bot, and the move list is sent");

    // A rematch swaps colours; a resignation ends it for the other side.
    const white = st.room.white;
    a.emit("rematch");
    st = await nextState(a, (s) => s.room.status === "playing");
    assert.notStrictEqual(st.room.white, white);
    passed++; console.log("  ok a rematch swaps white");
    a.emit("resign");
    st = await nextState(a, (s) => s.room.status === "over");
    assert.strictEqual(st.room.result.reason, "resign");
    assert.notStrictEqual(st.room.winner, st.mySeat);
    passed++; console.log("  ok resigning hands the game to the other side");
    a.close();

    // Clocks: a 3+2 game starts its clock on White's first move and adds two seconds after each move.
    const k = client();
    k.emit("create", { name: "Kai", playerId: "p_kai" });
    await nextState(k, (s) => s.room.players.length === 1);
    k.emit("settings", { tc: "3+2" });
    await nextState(k, (s) => s.room.tc === "3+2");
    k.emit("addBot");
    await nextState(k, (s) => s.room.players.length === 2);
    k.emit("start");
    let ks = await nextState(k, (s) => s.room.status === "playing");
    const base = 3 * 60000 * Number(process.env.CLOCK_SCALE_TEST || 1);
    if (ks.room.white === ks.mySeat) {
      assert.ok(ks.room.clock && ks.room.clock.running === null && ks.room.clock.w === base, "no clock runs before White's first move");
      k.emit("move", { uci: ks.room.legal[0] });
      ks = await nextState(k, (s) => s.room.turn === s.mySeat && s.room.lastMove && s.room.lastMove.mv >= 2);
    } else {
      ks = await nextState(k, (s) => s.room.turn === s.mySeat && s.room.lastMove);
    }
    const mine = ks.room.white === ks.mySeat ? "w" : "b";
    assert.strictEqual(ks.room.clock.running, mine, "our clock runs on our turn");
    passed++; console.log("  ok a clock starts with White's first move and runs only on its side's turn");
    k.close();

    // Running out of time loses (a scaled-down server: a minute is 300 ms).
    const fast = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: PORT + 1, BOT_MS: "5", CLOCK_SCALE: "0.005" }), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 600));
    try {
      const f = io(`http://127.0.0.1:${PORT + 1}`, { transports: ["websocket"], forceNew: true });
      f.emit("create", { name: "Fay", playerId: "p_fay" });
      await nextState(f, (s) => s.room.players.length === 1);
      f.emit("settings", { tc: "1+0" });
      await nextState(f, (s) => s.room.tc === "1+0");
      f.emit("addBot");
      await nextState(f, (s) => s.room.players.length === 2);
      f.emit("start");
      let fs = await nextState(f, (s) => s.room.status === "playing");
      if (fs.room.white === fs.mySeat) { f.emit("move", { uci: fs.room.legal[0] }); }
      // We then sit on our clock until it runs out.
      fs = await nextState(f, (s) => s.room.status === "over", 8000);
      assert.strictEqual(fs.room.result.reason, "time");
      assert.notStrictEqual(fs.room.winner, fs.mySeat);
      assert.strictEqual(fs.room.clock[fs.room.white === fs.mySeat ? "w" : "b"], 0);
      passed++; console.log("  ok running out of time loses the game");
      f.close();
    } finally { fast.kill(); }

    // What players type is kept friendly (moderation.js): a push to self-harm is removed, swearing is starred.
    const mc = client(); mc.emit("create", { name: "Mo", playerId: "p_mod" });
    await nextState(mc, (s) => s.room.players.length === 1);
    mc.emit("chat", { t: "kill yourself" });
    await nextState(mc, (s) => s.room.chat.some((c) => c.t === "(message removed)"), 30000);
    await new Promise((r) => setTimeout(r, 800));
    mc.emit("chat", { t: "what the fuck" });
    await nextState(mc, (s) => s.room.chat.some((c) => c.t === "what the f***"), 30000);
    passed++; console.log("  ok chat: a push to self-harm is removed, swearing is starred");
    mc.close();

    // A third player cannot sit at a two-seat board.
    const h = client(); h.emit("create", { name: "Host", playerId: "p_h" });
    const hs = await nextState(h, (s) => s.room.players.length === 1);
    const b = client(); b.emit("join", { code: hs.room.code, name: "Ben", playerId: "p_b" });
    await nextState(h, (s) => s.room.players.length === 2);
    const c = client();
    const refused = new Promise((res) => c.on("refusal", res));
    c.emit("join", { code: hs.room.code, name: "Cy", playerId: "p_c" });
    assert.strictEqual((await refused).code, "full");
    passed++; console.log("  ok the board seats two");
    h.close(); b.close(); c.close();
  } finally {
    srv.kill();
  }
}

games().then(() => { console.log(`all ${passed} passed`); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
