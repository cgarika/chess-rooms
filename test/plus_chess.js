/* Chess: GameNest Plus's puzzles and game review over real sockets (2026-10-17). */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const Puzzles = require("../puzzles");
const { review, reviewWith, winPct } = require("../review");
const Sf = require("../sf");

const PORT = Number(process.env.TEST_PORT || 3295);
const URL = `http://127.0.0.1:${PORT}`;
let passed = 0;
const ok = (name) => { passed++; console.log("  ok " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = () => io(URL, { transports: ["websocket"], forceNew: true });
function wait(fn, ms = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timeout")); setTimeout(tick, 15); };
    tick();
  });
}

async function main() {
  // ---- the pieces on their own
  console.log("plus chess: modules");
  assert.strictEqual(Puzzles.ALL.length, 3150);
  assert.ok(Puzzles.ALL.every((p) => p.moves.length >= 2 && p.moves.length % 2 === 0));
  ok("3150 puzzles, each an even line");
  const d1 = Puzzles.daily(new Date("2026-10-17T03:00:00Z")), d2 = Puzzles.daily(new Date("2026-10-17T22:00:00Z"));
  assert.strictEqual(d1.id, d2.id);
  assert.notStrictEqual(Puzzles.daily(new Date("2026-10-18T03:00:00Z")).id, d1.id);
  assert.ok(d1.rating >= 1000 && d1.rating < 1800);
  ok("the day's puzzle: one a UTC day, rated 1000-1800");
  const p = Puzzles.near(1500, [], () => 0.5);
  assert.ok(Math.abs(p.rating - 1500) <= 150);
  ok("a puzzle near the solver's rating");
  // Solve one along its line, and try a wrong move.
  const pz = Puzzles.BY_ID.get(d1.id);
  let done = [];
  let st = Puzzles.step(pz, done);
  assert.strictEqual(st.status, "playing");
  assert.strictEqual(st.lastMove, pz.moves[0]);
  for (let i = 1; i < pz.moves.length; i += 2) {
    st = Puzzles.step(pz, done, pz.moves[i]);
    assert.notStrictEqual(st.status, "wrong", "the solution's move " + pz.moves[i]);
    done.push(pz.moves[i]);
  }
  assert.strictEqual(st.status, "solved");
  ok("the solution's line solves it");
  const fresh = Puzzles.step(pz, []);
  const wrong = fresh.legal.find((u) => u !== pz.moves[1] && !Puzzles.step(pz, [], u).status.startsWith("solved") && Puzzles.step(pz, [], u).status === "wrong");
  assert.ok(wrong, "a wrong legal move exists");
  assert.strictEqual(Puzzles.step(pz, [], wrong).status, "wrong");
  ok("a wrong move is wrong, the board as it was");
  assert.ok(Puzzles.rated(1500, 1500, true) === 12 && Puzzles.rated(1500, 1500, false) === -12);
  ok("puzzle rating: +12 / -12 against an equal one");
  // The review on its own: Scholar's mate.
  const r = review(["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"], { budgetMs: 80 });
  assert.strictEqual(r.plies.length, 7);
  assert.strictEqual(r.plies[5].cls, "blunder");
  assert.strictEqual(r.plies[6].cls, "best");
  assert.strictEqual(r.plies[6].mate > 0, true);
  assert.ok(r.accuracy.w > r.accuracy.b);
  assert.ok(winPct(0) === 50 && winPct(400) > 75);
  ok("review: Nf6?? is a blunder, Qxf7# best, White the more accurate");
  // The same game by Stockfish (sf.js), as the server's reviews are judged.
  assert.ok(Sf.available(), "Stockfish's engine files are in engine/");
  const sf = await Sf.open(60);
  const rs = await reviewWith(sf.search, ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]);
  sf.quit();
  assert.strictEqual(rs.plies[5].cls, "blunder", "Stockfish: Nf6?? " + rs.plies[5].cls);
  assert.strictEqual(rs.plies[6].cls, "best");
  assert.strictEqual(rs.plies[6].mate, 1);
  assert.ok(rs.accuracy.w > rs.accuracy.b);
  ok("Stockfish's review: Nf6?? a blunder, Qxf7# best and mate, White the more accurate");

  // ---- over sockets
  const env = Object.assign({}, process.env, { PORT, START_WHITE: "host", BOT_MS: "5", AFK_MS: "5000", BOT_DEPTH: "1", REVIEW_MS: "40" });
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "ignore" });
  await sleep(700);
  const socks = [];
  try {
    console.log("plus chess: puzzles");
    const a = client(); socks.push(a);
    let got = null, refused = null;
    a.on("puzzle", (m) => { got = m; });
    a.on("refusal", (m) => { refused = m; });
    a.emit("puzzle", { rating: 1400 });
    await wait(() => refused);
    assert.strictEqual(refused.code, "plus");
    ok("another puzzle without Plus: refused, code plus");
    a.emit("puzzle", { daily: true, rating: 1400 });
    await wait(() => got);
    assert.strictEqual(got.id, Puzzles.daily().id);
    assert.ok(got.board && got.legal.length > 0 && got.headline);
    ok("the day's puzzle without Plus: a board, its moves and a headline");
    const line = Puzzles.BY_ID.get(got.id).moves;
    got = null;
    a.emit("puzzleHint");
    await wait(() => got && got.hint);
    assert.strictEqual(got.hintFrom, line[1].slice(0, 2));
    ok("a hint shows the square to move from");
    for (let i = 1; i < line.length; i += 2) {
      got = null;
      a.emit("puzzleMove", { uci: line[i] });
      await wait(() => got);
    }
    assert.strictEqual(got.status, "solved");
    assert.strictEqual(got.ratingDelta, 0);
    ok("solved after a hint: no rating gained");
    got = null;
    a.emit("puzzle", { rating: 1400, plus: true, seen: [] });
    await wait(() => got);
    const pl = Puzzles.BY_ID.get(got.id);
    const bad = got.legal.find((u) => u !== pl.moves[1] && Puzzles.step(pl, [], u).status === "wrong");
    got = null;
    a.emit("puzzleMove", { uci: bad });
    await wait(() => got);
    assert.strictEqual(got.status, "wrong");
    assert.ok(got.ratingDelta < 0);
    got = null;
    a.emit("puzzleMove", { uci: pl.moves[1] });
    await wait(() => got);
    assert.notStrictEqual(got.status, "wrong");
    assert.strictEqual(got.ratingDelta === null || got.ratingDelta === undefined, true);
    ok("Plus: a puzzle near the rating; a wrong first try costs rating, a retry counts nothing");

    console.log("plus chess: review");
    /* A refusal is kept beside the last state, not inside it (2026-11-13). It used to be written into the last state's object, and every
       new state replaces that object: since quick play and ranked (2026-10-24) the server sends one more state up to half a second after
       a game ends (the ratings: `ranked` and `rated`), and when that state landed between the refusal and this test's next look
       (it looks every 15 ms) the refusal was gone and the wait below ran out ("FAIL timeout": 2 runs in 12 on a server that had refused
       rightly both times). What is asserted is what it always was. */
    const last = new Map(), refusals = new Map();
    const table = async (plus) => {
      const h = client(); socks.push(h);
      h.on("state", (s) => last.set(h, s.room));
      h.on("refusal", (m) => refusals.set(h, m));
      h.emit("create", { name: "Host", playerId: "p_h" + Math.random(), plus });
      await wait(() => last.get(h) && last.get(h).players.length === 1);
      h.emit("addBot");
      await wait(() => last.get(h).players.length === 2);
      h.emit("start");
      await wait(() => last.get(h).status === "playing");
      await wait(() => last.get(h).turn === 0);
      h.emit("move", { uci: "e2e4" });
      await wait(() => last.get(h).moves.length >= 2);
      h.emit("resign");
      await wait(() => last.get(h).status === "over");
      return h;
    };
    const plain = await table(false);
    plain.emit("review");
    await wait(() => refusals.get(plain));
    assert.strictEqual(refusals.get(plain).code, "plus");
    assert.strictEqual(last.get(plain).review, null);
    ok("review in an ordinary room: refused, code plus");
    const plusT = await table(true);
    plusT.emit("review");
    const done = await wait(() => { const s = last.get(plusT); return s.review && s.review.status === "done" && s; }, 20000);
    assert.strictEqual(done.review.plies.length, done.moves.length);
    assert.ok(done.review.plies.every((x) => x.cls && x.san));
    assert.ok(Number.isFinite(done.review.accuracy.w));
    assert.strictEqual(done.review.engine, "stockfish");
    ok("review in a Plus room: every move judged by Stockfish, with accuracy");

    console.log("plus chess: the strong coaches");
    const coach = async (plus) => {
      const h = client(); socks.push(h);
      h.on("state", (st) => last.set(h, st.room));
      h.on("refusal", (m) => refusals.set(h, m));
      h.emit("create", { name: "Host", playerId: "c_h" + Math.random(), plus });
      await wait(() => last.get(h) && last.get(h).players.length === 1);
      h.emit("addBot");
      await wait(() => last.get(h).players.length === 2);
      return h;
    };
    const free = await coach(false);
    free.emit("settings", { level: "expert" });
    await wait(() => refusals.get(free));
    assert.strictEqual(refusals.get(free).code, "plus");
    assert.notStrictEqual(last.get(free).level, "expert");
    ok("Expert outside a Plus room: refused, code plus");
    const strong = await coach(true);
    strong.emit("settings", { level: "master" });
    await wait(() => last.get(strong).level === "master");
    strong.emit("start");
    await wait(() => last.get(strong).status === "playing" && last.get(strong).turn === 0);
    strong.emit("move", { uci: "e2e4" });
    const after = await wait(() => { const st = last.get(strong); return st.moves.length >= 2 && st; }, 15000);
    assert.ok(["e5", "c5", "e6", "c6", "d5", "Nf6", "d6", "g6", "Nc6"].includes(after.moves[1]), "Master's answer to 1.e4: " + after.moves[1]);
    ok("Master (Stockfish) answers 1.e4 with " + after.moves[1]);
  } finally {
    socks.forEach((s) => s.close());
    srv.kill();
  }
  console.log(`plus chess: all ${passed} passed`);
  process.exit(0);   // Stockfish's engine keeps the event loop alive
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
