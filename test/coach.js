/* Chess: the coach's stock (2026-11-13): hints, take-backs and review tickets, scripted and over real sockets.
   Starts its own server on TEST_PORT (default 3299; never 3111-3126), with its records in a folder of its own. */
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { io } = require("socket.io-client");
const Coach = require("../coach");
const Puzzles = require("../puzzles");

const PORT = Number(process.env.TEST_PORT || 3299);
const URL = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n    " + ((e && e.stack) || e)); }
}

/* ---------- a client that remembers what it was told ---------- */
const socks = [];
function client() {
  const s = io(URL, { transports: ["websocket"], forceNew: true });
  s.last = null; s.states = 0; s.used = []; s.refusals = []; s.puzzles = []; s.pzCoach = [];
  s.on("state", (m) => { s.last = m; s.states++; });
  s.on("coachUsed", (m) => s.used.push(m));
  s.on("refusal", (m) => s.refusals.push(m));
  s.on("puzzle", (m) => s.puzzles.push(m));
  s.on("puzzleCoach", (m) => s.pzCoach.push(m));
  socks.push(s);
  return s;
}
const cur = (s) => s.last.room;
function until(s, pred, ms = 8000, what = "") {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      let hit = false;
      try { hit = !!(s.last && pred(s.last.room, s.last)); } catch (e) { hit = false; }
      if (hit) return res(s.last.room);
      if (Date.now() - t0 > ms) return rej(new Error("timeout waiting " + what + "; log=" + (s.last && s.last.room.log)));
      setTimeout(tick, 10);
    };
    tick();
  });
}
function wait(fn, ms = 8000, what = "") {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => { let v = null; try { v = fn(); } catch (e) { v = null; } if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timeout waiting " + what)); setTimeout(tick, 10); };
    tick();
  });
}
let ids = 0;
const pid = (tag) => `p_${tag}_${process.pid}_${++ids}`;
const CAPS = ["coach", "waitList"];

/* A table against the coach bot (the host has white: START_WHITE=host), or against a guest. `host` and `guest` are what
   each says on create / join. */
async function table({ host = {}, guest = null, bot = true } = {}) {
  const h = client();
  const hid = host.playerId || pid("h");
  h.emit("create", Object.assign({ name: "Host", playerId: hid }, host));
  const r = await until(h, (x) => x.players.length === 1, 8000, "the room");
  let g = null, gid = null;
  if (guest) { g = client(); gid = guest.playerId || pid("g"); g.emit("join", Object.assign({ code: r.code, name: "Guest", playerId: gid }, guest)); }
  else if (bot) h.emit("addBot");
  await until(h, (x) => x.players.length === 2, 8000, "two seats");
  h.emit("start");
  await until(h, (x) => x.status === "playing", 8000, "the game");
  if (g) await until(g, (x) => x.status === "playing", 8000, "the game (guest)");
  return { h, g, code: r.code, hid, gid };
}
/* My move (a quiet one that is legal), and, against the bot, its reply. */
const QUIET = ["a2a3", "h2h3", "b2b3", "g2g3", "c2c3", "f2f3", "a3a4", "h3h4", "b3b4", "g3g4", "d2d3", "e2e3"];
async function move(s, uci, replies = true) {
  const n = cur(s).moves.length;
  const pick = uci || QUIET.find((u) => cur(s).legal.includes(u)) || cur(s).legal[0];
  s.emit("move", { uci: pick });
  await until(s, (x) => x.status !== "playing" || (replies ? x.moves.length >= n + 2 && x.turn === s.last.mySeat : x.moves.length > n), 8000, "the move " + pick);
  assert.strictEqual(cur(s).status, "playing", "the game goes on");
}
const hintOf = (s) => cur(s).hint;
/* Ask and wait for the answer: a state, or a refusal. `event` is "hint", "offer", "review"... */
async function ask(s, event, payload) {
  const before = s.states, r0 = s.refusals.length;
  s.emit(event, payload);
  await wait(() => s.states > before || s.refusals.length > r0, 4000, "an answer to " + event);
  await sleep(50);
}
/* Send something the server says nothing to, and see that it said nothing. */
async function silent(s, event, payload, ms = 200) {
  const before = s.states, r0 = s.refusals.length, u0 = s.used.length;
  s.emit(event, payload);
  await sleep(ms);
  assert.strictEqual(s.states, before, event + ": no state");
  assert.strictEqual(s.refusals.length, r0, event + ": no refusal");
  assert.strictEqual(s.used.length, u0, event + ": nothing spent");
}
const lastKey = (o) => Object.keys(o)[Object.keys(o).length - 1];

/* ---------- the rules on their own (coach.js) ---------- */
async function scripted() {
  console.log("coach: the rules on their own");
  await test("a stock is whole numbers, 0 to 99, and nothing else", () => {
    assert.deepStrictEqual(Coach.clean({ hint: 5, takeback: 100, review: -2 }), { hint: 5, takeback: 99, review: 0 });
    assert.deepStrictEqual(Coach.clean({ hint: "5", takeback: 1.5, review: null, bomb: 9 }), { hint: 0, takeback: 0, review: 0 });
    for (const junk of [null, undefined, 7, "x", [], [3, 3, 3], true]) assert.deepStrictEqual(Coach.clean(junk), { hint: 0, takeback: 0, review: 0 });
    assert.strictEqual(Coach.STOCK_MAX, 99);
    assert.deepStrictEqual(Coach.FREE, { hint: 3, takeback: 1 });
    assert.deepStrictEqual(Coach.PUZZLE_FREE, { hint: 3 });
  });
  await test("an app that does not say \"coach\" owns nothing and is given nothing", () => {
    for (const caps of [undefined, null, [], ["waitList"], "coach", { coach: true }, ["Coach"]]) {
      const ck = Coach.seat(caps, { hint: 9, takeback: 9, review: 9 });
      assert.strictEqual(ck.knows, false);
      assert.deepStrictEqual(ck.stock, { hint: 0, takeback: 0, review: 0 });
      assert.strictEqual(Coach.take(ck, { hint: 4 }, "g"), false);
      assert.strictEqual(Coach.use(ck, "hint", false), null);
      assert.strictEqual(Coach.use(ck, "hint", true), null);
    }
  });
  await test("three free hints a game, then the stock, then none", () => {
    const ck = Coach.seat(["coach"], { hint: 2, takeback: 0, review: 0 });
    for (let i = 0; i < 3; i++) { assert.deepStrictEqual(Coach.use(ck, "hint", false), { paid: false }); assert.strictEqual(Coach.me(ck).free.hint, 2 - i); }
    assert.deepStrictEqual(ck.stock, { hint: 2, takeback: 0, review: 0 });
    assert.deepStrictEqual(Coach.use(ck, "hint", false), { paid: true, left: 1 });
    assert.deepStrictEqual(Coach.use(ck, "hint", false), { paid: true, left: 0 });
    assert.strictEqual(Coach.use(ck, "hint", false), null);
    assert.strictEqual(Coach.use(ck, "hint", false), null);
    assert.deepStrictEqual(Coach.me(ck), { free: { hint: 0, takeback: 1 }, stock: { hint: 0, takeback: 0, review: 0 }, spent: { hint: 2, takeback: 0, review: 0 } });
  });
  await test("one free take-back a game, then the stock; a review ticket is never free; no such kind", () => {
    const ck = Coach.seat(["coach"], { hint: 0, takeback: 1, review: 1 });
    assert.deepStrictEqual(Coach.use(ck, "takeback", false), { paid: false });
    assert.deepStrictEqual(Coach.use(ck, "takeback", false), { paid: true, left: 0 });
    assert.strictEqual(Coach.use(ck, "takeback", false), null);
    assert.deepStrictEqual(Coach.use(ck, "review", false, {}), { paid: true, left: 0 });
    assert.strictEqual(Coach.use(ck, "review", false, {}), null);
    assert.strictEqual(Coach.use(ck, "bomb", false), null);
    assert.strictEqual(Coach.use(ck, "__proto__", false), null);
    assert.deepStrictEqual(ck.spent, { hint: 0, takeback: 1, review: 1 });
  });
  await test("Plus: no limits, nothing counted, nothing spent", () => {
    const ck = Coach.seat(["coach"], { hint: 1, takeback: 1, review: 1 });
    for (let i = 0; i < 40; i++) { assert.deepStrictEqual(Coach.use(ck, "hint", true), { paid: false, plus: true }); assert.deepStrictEqual(Coach.use(ck, "takeback", true), { paid: false, plus: true }); }
    assert.deepStrictEqual(Coach.me(ck), { free: { hint: 3, takeback: 1 }, stock: { hint: 1, takeback: 1, review: 1 }, spent: { hint: 0, takeback: 0, review: 0 } });
  });
  await test("a stock said again: the app's count less this game's paid uses it has not counted (seen)", () => {
    const ck = Coach.seat(["coach"], { hint: 5, takeback: 2, review: 0 });
    for (let i = 0; i < 5; i++) Coach.use(ck, "hint", false);   // three free, two paid
    Coach.use(ck, "takeback", false); Coach.use(ck, "takeback", false);   // one free, one paid
    assert.deepStrictEqual(ck.stock, { hint: 3, takeback: 1, review: 0 });
    // The app counted nothing yet: its 5 and 2 are before the uses.
    Coach.take(ck, { hint: 5, takeback: 2, review: 0 }, "g1");
    assert.deepStrictEqual(ck.stock, { hint: 3, takeback: 1, review: 0 });
    // It counted one of the two hints.
    Coach.take(ck, { hint: 4, takeback: 2, review: 0, seen: { game: "g1", hint: 1 } }, "g1");
    assert.deepStrictEqual(ck.stock, { hint: 3, takeback: 1, review: 0 });
    // It counted everything, and bought five hints.
    Coach.take(ck, { hint: 8, takeback: 1, review: 3, seen: { game: "g1", hint: 2, takeback: 1 } }, "g1");
    assert.deepStrictEqual(ck.stock, { hint: 8, takeback: 1, review: 3 });
    // A `seen` of another game counts for nothing, and one that says more than was spent gives nothing away.
    Coach.take(ck, { hint: 8, takeback: 1, review: 3, seen: { game: "g0", hint: 2, takeback: 1 } }, "g1");
    assert.deepStrictEqual(ck.stock, { hint: 6, takeback: 0, review: 3 });
    Coach.take(ck, { hint: 8, takeback: 1, review: 3, seen: { game: "g1", hint: 99, takeback: 99, review: 99 } }, "g1");
    assert.deepStrictEqual(ck.stock, { hint: 8, takeback: 1, review: 3 });
    // Junk is not a stock: nothing changes.
    for (const junk of [null, 5, "x", [1, 2, 3]]) assert.strictEqual(Coach.take(ck, junk, "g1"), false);
    assert.deepStrictEqual(ck.stock, { hint: 8, takeback: 1, review: 3 });
    // An empty object is an empty stock (the whole stock is said each time).
    Coach.take(ck, {}, "g1");
    assert.deepStrictEqual(ck.stock, { hint: 0, takeback: 0, review: 0 });
  });
  await test("a new game: the free ones are back, nothing is spent, the stock is as the server counted it", () => {
    const ck = Coach.seat(["coach"], { hint: 4, takeback: 4, review: 4 });
    for (let i = 0; i < 4; i++) Coach.use(ck, "hint", false);
    Coach.use(ck, "takeback", false); Coach.use(ck, "takeback", false); Coach.use(ck, "review", false, {});
    Coach.fresh(ck);
    assert.deepStrictEqual(Coach.me(ck), { free: { hint: 3, takeback: 1 }, stock: { hint: 3, takeback: 3, review: 3 }, spent: { hint: 0, takeback: 0, review: 0 } });
  });
  await test("a puzzle's three free hints are its own count", () => {
    const ck = Coach.seat(["coach"], { hint: 1 });
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(Coach.use(ck, "hint", false, Coach.PUZZLE_FREE), { paid: false });
    assert.deepStrictEqual(Coach.me(ck, Coach.PUZZLE_FREE), { free: { hint: 0 }, stock: { hint: 1, takeback: 0, review: 0 }, spent: { hint: 0, takeback: 0, review: 0 } });
    assert.deepStrictEqual(Coach.use(ck, "hint", false, Coach.PUZZLE_FREE), { paid: true, left: 0 });
    assert.strictEqual(Coach.use(ck, "hint", false, Coach.PUZZLE_FREE), null);
  });
}

/* ---------- over the wire ---------- */
const HEX8 = /^[0-9a-f]{8}$/;
const NO_HINTS = { code: "coach", message: "No hints left. Get more in the Shop.", op: "hint" };
const NO_TAKEBACKS = { code: "coach", message: "No take-backs left. Get more in the Shop.", op: "offer" };
const NO_TICKETS = { code: "coach", message: "No review tickets left. Get more in the Shop.", op: "review" };
const refusalOf = (m) => ({ code: m.code, message: m.message, op: m.op });
const lastRefusal = (s) => refusalOf(s.refusals[s.refusals.length - 1]);
async function resign(s) { s.emit("resign"); await until(s, (x) => x.status === "over", 8000, "the end"); }
async function takeback(s) {
  const n = cur(s).moves.length, r0 = s.refusals.length;
  s.emit("offer", { kind: "takeback" });
  await wait(() => cur(s).moves.length < n || s.refusals.length > r0, 4000, "an answer to the take-back");
  await sleep(50);
  return cur(s).moves.length < n;
}

async function wireOldApp() {
  console.log("coach: an app that does not know the stock");
  await test("an old app: free hints without end, take-backs as ever, nothing new in its state, its game still rated", async () => {
    const { h } = await table({ host: { coach: { hint: 9, takeback: 9, review: 9 } } });   // says a stock, but not the cap
    assert.ok(!("coach" in cur(h)), "no coach key");
    assert.strictEqual(cur(h).rankedOn, true);
    for (let i = 0; i < 6; i++) {
      await ask(h, "hint");
      assert.ok(hintOf(h) && hintOf(h).seat === 0, "hint " + (i + 1));
      await ask(h, "hint");   // asked again on the same board: answered again, as it always was
      assert.ok(hintOf(h));
      await move(h);
      assert.strictEqual(hintOf(h), null);
    }
    for (let i = 0; i < 3; i++) { assert.strictEqual(await takeback(h), true, "take-back " + (i + 1)); await move(h); }
    h.emit("coachStock", { hint: 5 }); await sleep(120);
    assert.ok(!("coach" in cur(h)));
    assert.strictEqual(h.used.length, 0); assert.strictEqual(h.refusals.length, 0);
    assert.strictEqual(cur(h).rankedOn, true, "an old app's game counts as it did");
    await resign(h);
    const r = await until(h, (x) => x.rated, 5000, "the rating");
    assert.ok(r.rated.results.length >= 1);
    h.emit("review"); await wait(() => h.refusals.length === 1, 3000, "the refusal");
    assert.deepStrictEqual(lastRefusal(h), { code: "plus", message: "Game review comes with GameNest Plus.", op: "review" });
    h.emit("review", { ticket: true }); await wait(() => h.refusals.length === 2, 3000, "the refusal");
    assert.strictEqual(lastRefusal(h).code, "plus");
    assert.strictEqual(cur(h).review, null); assert.strictEqual(h.used.length, 0);
  });
}

async function wireHints() {
  console.log("coach: hints");
  let h, w, game;
  await test("a coach app: `coach` is the last key of its own state", async () => {
    h = client();
    const hid = pid("h");
    h.emit("create", { name: "Host", playerId: hid, caps: CAPS, coach: { hint: 2, takeback: 1, review: 1 } });
    let r = await until(h, (x) => x.players.length === 1);
    assert.strictEqual(lastKey(r), "coach");
    assert.deepStrictEqual(r.coach, { game: null, on: false, helped: false, free: { hint: 3, takeback: 1 },
      me: { free: { hint: 3, takeback: 1 }, stock: { hint: 2, takeback: 1, review: 1 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: false, review: false } });
    h.emit("addBot"); r = await until(h, (x) => x.players.length === 2);
    assert.strictEqual(r.coach.on, true);
    h.emit("start"); r = await until(h, (x) => x.status === "playing");
    game = r.coach.game;
    assert.ok(HEX8.test(game), "a game id: " + game);
    assert.strictEqual(lastKey(r), "coach");
    assert.strictEqual(r.rankedOn, true); assert.strictEqual(r.coach.helped, false);
    // Someone watching from the line: told nothing of it.
    w = client();
    w.emit("join", { code: r.code, name: "Watcher", playerId: pid("w"), caps: CAPS, coach: { hint: 7 } });
    await until(w, (x) => x.waiting && x.waiting.length === 1);
    assert.ok(!("coach" in cur(w)));
  });
  await test("three free hints a game; one on the board is not asked for twice", async () => {
    for (let i = 0; i < 3; i++) {
      await ask(h, "hint");
      assert.ok(hintOf(h) && hintOf(h).seat === 0);
      assert.strictEqual(cur(h).coach.me.free.hint, 2 - i);
      await silent(h, "hint");   // the same board: nothing said, nothing counted
      await move(h);
    }
    assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 2, takeback: 1, review: 1 });
    assert.deepStrictEqual(cur(h).coach.me.spent, { hint: 0, takeback: 0, review: 0 });
    assert.strictEqual(h.used.length, 0);
  });
  await test("a game the coach helped in is not rated (rankedOn turns false at the first hint)", async () => {
    assert.strictEqual(cur(h).coach.helped, true);
    assert.strictEqual(cur(h).rankedOn, false);
  });
  await test("after the free ones a hint costs one of the stock: coachUsed to the player alone, and coach.me agrees", async () => {
    await ask(h, "hint");
    assert.deepStrictEqual(h.used, [{ kind: "hint", left: 1, game }]);
    assert.ok(hintOf(h));
    assert.deepStrictEqual(cur(h).coach.me, { free: { hint: 0, takeback: 1 }, stock: { hint: 1, takeback: 1, review: 1 }, spent: { hint: 1, takeback: 0, review: 0 }, plus: false, review: false });
    await silent(h, "hint");
    await move(h);
    await ask(h, "hint");
    assert.deepStrictEqual(h.used[1], { kind: "hint", left: 0, game });
    await move(h);
    assert.strictEqual(w.used.length, 0); assert.ok(!("coach" in cur(w)), "the watcher is told nothing");
  });
  await test("none left: refused in plain words, nothing shown", async () => {
    await ask(h, "hint");
    assert.deepStrictEqual(lastRefusal(h), NO_HINTS);
    assert.strictEqual(hintOf(h), null); assert.strictEqual(h.used.length, 2);
    await ask(h, "hint");
    assert.strictEqual(h.refusals.length, 2);
  });
  await test("coachStock: the app's count, less this game's paid uses it has not counted (seen)", async () => {
    // The app took both uses off its count (0 left) and bought three.
    await ask(h, "coachStock", { hint: 3, takeback: 1, review: 1, seen: { game, hint: 2 } });
    assert.strictEqual(cur(h).coach.me.stock.hint, 3);
    // The same count without `seen`, or with another game's: the two uses come off it.
    await ask(h, "coachStock", { hint: 3, takeback: 1, review: 1 });
    assert.strictEqual(cur(h).coach.me.stock.hint, 1);
    await ask(h, "coachStock", { hint: 3, takeback: 1, review: 1, seen: { game: "00000000", hint: 2 } });
    assert.strictEqual(cur(h).coach.me.stock.hint, 1);
    // Clamped: never more than 99, never a fraction or a word.
    await ask(h, "coachStock", { hint: 1e9, takeback: -4, review: 2.5, seen: { game, hint: 2 } });
    assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 99, takeback: 0, review: 0 });
    await ask(h, "coachStock", { hint: 3, takeback: 1, review: 1, seen: { game, hint: 2 } });
    await ask(h, "hint");
    assert.deepStrictEqual(h.used[2], { kind: "hint", left: 2, game });
    assert.ok(hintOf(h));
    assert.strictEqual(w.used.length, 0);
  });
  await test("no hint outside a game, and the helped game stays unrated to its end", async () => {
    w.close(); await until(h, (x) => x.waiting.length === 0, 4000, "the watcher gone");   // (or the rematch would seat them)
    await resign(h);
    await silent(h, "hint");
    await sleep(900);   // the ratings' scan has passed
    assert.strictEqual(cur(h).rated, undefined); assert.strictEqual(cur(h).rankedOn, false);
    const lobby = client();
    lobby.emit("create", { name: "Lone", playerId: pid("l"), caps: CAPS, coach: { hint: 3 } });
    await until(lobby, (x) => x.players.length === 1);
    await silent(lobby, "hint");
    lobby.emit("addBot"); await until(lobby, (x) => x.players.length === 2);
    await silent(lobby, "hint");
    assert.strictEqual(cur(lobby).coach.me.free.hint, 3);
  });
  await test("a rematch: the free ones are back, nothing spent, the stock as the server counted it, rated again", async () => {
    h.emit("rematch");
    const r = await until(h, (x) => x.status === "playing" && x.coach.game !== game, 8000, "the rematch");
    assert.ok(HEX8.test(r.coach.game));
    assert.deepStrictEqual(r.coach.me, { free: { hint: 3, takeback: 1 }, stock: { hint: 2, takeback: 1, review: 1 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: false, review: false });
    assert.strictEqual(r.coach.helped, false); assert.strictEqual(r.rankedOn, true); assert.strictEqual(r.hint, null);
    assert.strictEqual(r.coach.on, true);
  });
  await test("a game against the coach he did not help in is rated, as ever", async () => {
    await move(h); await move(h);
    await sleep(600);   // (the ratings' scan, twice a second, has to see the new game begin before it can see it end)
    await resign(h);
    const r = await until(h, (x) => x.rated, 5000, "the rating");
    assert.strictEqual(r.coach.helped, false); assert.strictEqual(r.rankedOn, true);
  });
}

async function wireTakebacks() {
  console.log("coach: take-backs");
  let h, game;
  await test("one free take-back a game against the coach, then the stock, then none", async () => {
    ({ h } = await table({ host: { caps: CAPS, coach: { hint: 0, takeback: 1, review: 0 } } }));
    game = cur(h).coach.game;
    // Nothing of mine to take back yet: as ever nothing happens, and nothing is counted.
    await silent(h, "offer", { kind: "takeback" });
    assert.strictEqual(cur(h).coach.me.free.takeback, 1);
    await move(h, "e2e4");
    assert.strictEqual(await takeback(h), true);
    assert.strictEqual(cur(h).moves.length, 0);
    assert.strictEqual(cur(h).coach.me.free.takeback, 0); assert.strictEqual(h.used.length, 0);
    assert.strictEqual(cur(h).coach.helped, true); assert.strictEqual(cur(h).rankedOn, false);
    await move(h, "d2d4");
    assert.strictEqual(await takeback(h), true);
    assert.deepStrictEqual(h.used, [{ kind: "takeback", left: 0, game }]);
    assert.deepStrictEqual(cur(h).coach.me, { free: { hint: 3, takeback: 0 }, stock: { hint: 0, takeback: 0, review: 0 }, spent: { hint: 0, takeback: 1, review: 0 }, plus: false, review: false });
    await move(h, "c2c4");
    assert.strictEqual(await takeback(h), false);
    assert.deepStrictEqual(lastRefusal(h), NO_TAKEBACKS);
    assert.strictEqual(cur(h).moves.length, 2); assert.strictEqual(cur(h).offer, null);
    assert.strictEqual(h.used.length, 1);
  });
  await test("more bought in the middle of the game are good at once", async () => {
    await ask(h, "coachStock", { hint: 0, takeback: 2, review: 0, seen: { game, takeback: 1 } });
    assert.strictEqual(cur(h).coach.me.stock.takeback, 2);
    assert.strictEqual(await takeback(h), true);
    assert.deepStrictEqual(h.used[1], { kind: "takeback", left: 1, game });
  });
  await test("a draw offer is not the coach's help: never counted", async () => {
    const before = JSON.stringify(cur(h).coach.me);
    await ask(h, "offer", { kind: "draw" });
    assert.strictEqual(JSON.stringify(cur(h).coach.me), before);
    assert.strictEqual(h.refusals.length, 1); assert.strictEqual(h.used.length, 2);
  });
}

async function wirePeople() {
  console.log("coach: against a person");
  await test("against a person the coach is not there: no hint, and a take-back is the other player's to give", async () => {
    const { h, g } = await table({ host: { caps: CAPS, coach: { hint: 5, takeback: 5, review: 0 } }, guest: { caps: CAPS, coach: { hint: 1, takeback: 0, review: 0 } } });
    assert.strictEqual(cur(h).coach.on, false); assert.strictEqual(cur(g).coach.on, false);
    assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 5, takeback: 5, review: 0 });
    assert.deepStrictEqual(cur(g).coach.me.stock, { hint: 1, takeback: 0, review: 0 }, "each is told their own stock, never the other's");
    assert.strictEqual(lastKey(cur(g)), "coach");
    await silent(h, "hint");
    assert.strictEqual(hintOf(h), null);
    await move(h, "e2e4", false);
    await until(g, (x) => x.moves.length === 1);
    await silent(g, "hint");
    g.emit("move", { uci: "e7e5" }); await until(h, (x) => x.moves.length === 2);
    // Two take-backs, both granted by the guest: none of them is the coach's.
    for (let i = 0; i < 2; i++) {
      await move(h, i ? "d2d4" : "g1f3", false);
      await until(g, (x) => x.moves.length === 3);
      h.emit("offer", { kind: "takeback" });
      await until(g, (x) => x.offer && x.offer.kind === "takeback");
      g.emit("reply", { accept: true });
      await until(h, (x) => x.moves.length === 2 && !x.offer);
    }
    assert.deepStrictEqual(cur(h).coach.me, { free: { hint: 3, takeback: 1 }, stock: { hint: 5, takeback: 5, review: 0 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: false, review: false });
    assert.strictEqual(cur(h).coach.helped, false); assert.strictEqual(cur(h).rankedOn, true);
    assert.strictEqual(h.used.length + g.used.length, 0); assert.strictEqual(h.refusals.length + g.refusals.length, 0);
  });
  await test("a table of a coach app and an old one: only the coach app is sent `coach`", async () => {
    const { h, g } = await table({ host: { caps: CAPS, coach: { hint: 2 } }, guest: { coach: { hint: 9 } } });
    assert.ok("coach" in cur(h)); assert.ok(!("coach" in cur(g)));
    assert.strictEqual(lastKey(cur(g)), "waitPos");
  });
}

async function finishedGame(hostSays, guestSays) {
  const t = await table({ host: hostSays, guest: guestSays });
  await move(t.h, "e2e4", false);
  await until(t.g, (x) => x.moves.length === 1);
  t.g.emit("move", { uci: "e7e5" }); await until(t.h, (x) => x.moves.length === 2);
  await move(t.h, "g1f3", false);
  await until(t.g, (x) => x.moves.length === 3);
  t.g.emit("resign");
  await until(t.h, (x) => x.status === "over"); await until(t.g, (x) => x.status === "over");
  return t;
}
const reviewDone = (s, ms = 20000) => until(s, (x) => x.review && x.review.status === "done", ms, "the review");

async function wireReview() {
  console.log("coach: review tickets");
  let h, g, w, game;
  await test("without Plus and without a ticket: refused as ever; with the cap but no ticket left: told so", async () => {
    ({ h, g } = await finishedGame({ caps: CAPS, coach: { hint: 0, takeback: 0, review: 1 } }, { caps: CAPS, coach: { hint: 0, takeback: 0, review: 0 } }));
    game = cur(h).coach.game;
    w = client();
    w.emit("join", { code: cur(h).code, name: "Watcher", playerId: pid("w"), caps: CAPS, coach: { review: 5 } });
    await until(w, (x) => x.waiting && x.waiting.length === 1);
    await ask(g, "review");
    assert.deepStrictEqual(lastRefusal(g), { code: "plus", message: "Game review comes with GameNest Plus.", op: "review" });
    for (const junk of [{ ticket: "true" }, { ticket: 1 }, { ticket: {} }]) { await ask(g, "review", junk); assert.strictEqual(lastRefusal(g).code, "plus"); }
    await ask(g, "review", { ticket: true });
    assert.deepStrictEqual(lastRefusal(g), NO_TICKETS);
    w.emit("review", { ticket: true }); await sleep(200);   // a watcher has no seat: nothing
    assert.strictEqual(cur(h).review, null); assert.strictEqual(w.used.length, 0);
  });
  await test("a ticket opens this game's review for its player alone: spent once, coachUsed to them alone", async () => {
    await ask(h, "review", { ticket: true });
    assert.deepStrictEqual(h.used, [{ kind: "review", left: 0, game }]);
    const r = await reviewDone(h);
    assert.strictEqual(r.review.plies.length, 3);
    assert.strictEqual(r.coach.me.review, true);
    assert.deepStrictEqual(r.coach.me.stock, { hint: 0, takeback: 0, review: 0 });
    assert.deepStrictEqual(r.coach.me.spent, { hint: 0, takeback: 0, review: 1 });
    await sleep(150);
    assert.strictEqual(cur(g).review, null, "the other player did not pay: no review");
    assert.strictEqual(cur(g).coach.me.review, false);
    assert.strictEqual(cur(w).review, null, "nor does a watcher see it");
    assert.strictEqual(g.used.length + w.used.length, 0);
  });
  await test("asking again for the same game is free", async () => {
    const before = h.states;
    h.emit("review", { ticket: true }); h.emit("review"); h.emit("review", { ticket: true });
    await sleep(250);
    assert.strictEqual(h.used.length, 1); assert.strictEqual(cur(h).coach.me.spent.review, 1);
    assert.strictEqual(cur(h).review.status, "done");
    assert.strictEqual(h.refusals.length, 0);
    void before;
  });
  await test("the other player buys tickets and opens the same review: their own ticket, their own count", async () => {
    await ask(g, "coachStock", { hint: 0, takeback: 0, review: 2 });
    assert.strictEqual(cur(g).coach.me.stock.review, 2);
    await ask(g, "review", { ticket: true });
    assert.deepStrictEqual(g.used, [{ kind: "review", left: 1, game }]);
    const r = await reviewDone(g, 8000);
    assert.strictEqual(r.review.plies.length, 3);
    assert.strictEqual(r.coach.me.review, true);
    assert.strictEqual(h.used.length, 1); assert.strictEqual(cur(h).coach.me.stock.review, 0);
    assert.strictEqual(cur(w).review, null);
  });
  await test("a rematch is another game: its review needs another ticket", async () => {
    w.close(); await until(h, (x) => x.waiting.length === 0);
    h.emit("rematch");
    await until(h, (x) => x.status === "playing" && x.coach.game !== game, 8000, "the rematch");
    assert.strictEqual(cur(h).coach.me.review, false); assert.strictEqual(cur(g).coach.me.review, false);
    const white = cur(h).turn === 0 ? h : g, black = white === h ? g : h;
    white.emit("move", { uci: "d2d4" }); await until(black, (x) => x.moves.length === 1);
    black.emit("resign"); await until(h, (x) => x.status === "over");
    assert.strictEqual(cur(h).review, null);
    await ask(h, "review", { ticket: true });
    assert.deepStrictEqual(lastRefusal(h), NO_TICKETS);
    await ask(g, "review", { ticket: true });
    assert.deepStrictEqual(g.used[1], { kind: "review", left: 0, game: cur(g).coach.game });
    await reviewDone(g);
    assert.strictEqual(cur(h).review, null);
  });
  await test("a Plus room: the review is everyone's, as ever, and no ticket is spent", async () => {
    const t = await finishedGame({ caps: CAPS, plus: true, coach: { hint: 0, takeback: 0, review: 3 } }, { caps: CAPS, coach: { review: 1 } });
    t.h.emit("review", { ticket: true });
    await reviewDone(t.h); await reviewDone(t.g);
    t.g.emit("review", { ticket: true }); await sleep(200);
    assert.strictEqual(t.h.used.length + t.g.used.length, 0);
    assert.strictEqual(cur(t.h).coach.me.stock.review, 3); assert.strictEqual(cur(t.g).coach.me.stock.review, 1);
    assert.strictEqual(cur(t.h).coach.me.plus, true); assert.strictEqual(cur(t.g).coach.me.plus, false);
    assert.strictEqual(cur(t.h).coach.me.review, false);
  });
}

async function wirePlusAndSeats() {
  console.log("coach: Plus, reconnects, the waiting line, quick play");
  await test("Plus: no limits and nothing spent (the game is still not rated once the coach helped)", async () => {
    const { h } = await table({ host: { caps: CAPS, plus: true, coach: { hint: 1, takeback: 1, review: 0 } } });
    assert.strictEqual(cur(h).coach.me.plus, true);
    for (let i = 0; i < 6; i++) { await ask(h, "hint"); assert.ok(hintOf(h), "hint " + (i + 1)); await move(h); }
    for (let i = 0; i < 3; i++) { assert.strictEqual(await takeback(h), true, "take-back " + (i + 1)); await move(h); }
    assert.deepStrictEqual(cur(h).coach.me, { free: { hint: 3, takeback: 1 }, stock: { hint: 1, takeback: 1, review: 0 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: true, review: false });
    assert.strictEqual(h.used.length, 0); assert.strictEqual(h.refusals.length, 0);
    assert.strictEqual(cur(h).rankedOn, false);
  });
  await test("a reconnect says the stock again: a use the app has not counted is not given back, one it has is not taken twice", async () => {
    const hid = pid("h");
    const says = { name: "Host", playerId: hid, caps: CAPS };
    const { h, code } = await table({ host: Object.assign({ coach: { hint: 2, takeback: 0, review: 0 } }, says) });
    const game = cur(h).coach.game;
    for (let i = 0; i < 4; i++) { await ask(h, "hint"); await move(h); }
    assert.deepStrictEqual(h.used, [{ kind: "hint", left: 1, game }]);
    h.close();
    // The app missed coachUsed: it still says 2.
    let h2 = client();
    h2.emit("join", Object.assign({ code, coach: { hint: 2, takeback: 0, review: 0 } }, says));
    let r = await until(h2, (x) => x.status === "playing" && x.coach);
    assert.deepStrictEqual(r.coach.me, { free: { hint: 0, takeback: 1 }, stock: { hint: 1, takeback: 0, review: 0 }, spent: { hint: 1, takeback: 0, review: 0 }, plus: false, review: false });
    assert.strictEqual(r.coach.game, game);
    h2.close();
    // The app had counted it: it says 1, and that this game's one use is in it.
    h2 = client();
    h2.emit("join", Object.assign({ code, coach: { hint: 1, takeback: 0, review: 0, seen: { game, hint: 1 } } }, says));
    r = await until(h2, (x) => x.status === "playing" && x.coach);
    assert.strictEqual(r.coach.me.stock.hint, 1);
    // A rejoin that says no caps at all (nothing about the stock) changes nothing.
    h2.close();
    h2 = client();
    h2.emit("join", { code, name: "Host", playerId: hid });
    r = await until(h2, (x) => x.status === "playing" && x.coach);
    assert.strictEqual(r.coach.me.stock.hint, 1); assert.strictEqual(r.coach.me.free.hint, 0);
    await until(h2, (x) => x.turn === 0 && x.legal.length > 0);
    await ask(h2, "hint");
    assert.deepStrictEqual(h2.used, [{ kind: "hint", left: 0, game }]);
  });
  await test("the waiting line: a watcher who takes a seat plays with their own stock", async () => {
    const { h, g } = await finishedGame({ caps: CAPS, coach: { hint: 1 } }, { caps: CAPS, coach: { hint: 9, takeback: 9, review: 9 } });
    const w = client();
    const wid = pid("w");
    w.emit("join", { code: cur(h).code, name: "Watcher", playerId: wid, caps: CAPS, coach: { hint: 4, takeback: 0, review: 0 } });
    await until(w, (x) => x.waiting && x.waiting.length === 1);
    assert.ok(!("coach" in cur(w)));
    w.emit("coachStock", { hint: 6, takeback: 2, review: 1 }); await sleep(120);   // bought while waiting
    assert.ok(!("coach" in cur(w)));
    g.emit("leave");
    await until(h, (x) => x.players.some((p) => p.left) || x.players.length === 1 || x.waiting.length === 0, 4000, "the guest gone");
    if (cur(h).status === "over") h.emit("rematch");
    const r = await until(w, (x) => x.status === "playing" && x.coach, 8000, "the watcher seated");
    assert.deepStrictEqual(r.coach.me.stock, { hint: 6, takeback: 2, review: 1 }, "their own, not the last sitter's");
    assert.deepStrictEqual(r.coach.me.free, { hint: 3, takeback: 1 });
    assert.strictEqual(r.coach.on, false);
    assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 1, takeback: 0, review: 0 });
  });
  await test("quick play carries the cap and the stock like create and join", async () => {
    const q = client();
    q.emit("quick", { name: "Quick", playerId: pid("q"), caps: CAPS, coach: { hint: 3, takeback: 2, review: 1 } });
    const r = await until(q, (x) => x.players.length >= 1 && x.coach, 5000, "the quick room");
    assert.deepStrictEqual(r.coach.me.stock, { hint: 3, takeback: 2, review: 1 });
    assert.strictEqual(lastKey(r), "coach");
    q.emit("leave"); await sleep(100);
  });
  await test("junk: a stock that is not one is an empty stock, and nothing breaks", async () => {
    const { h } = await table({ host: { caps: CAPS, coach: "lots" } });
    assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 0, takeback: 0, review: 0 });
    await ask(h, "coachStock", { hint: 4, takeback: "3", review: [1], seen: "x" });
    assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 4, takeback: 0, review: 0 });
    for (const junk of [null, 7, "x", [9, 9, 9]]) { await ask(h, "coachStock", junk); assert.deepStrictEqual(cur(h).coach.me.stock, { hint: 0, takeback: 0, review: 0 }, "the whole stock is said each time"); }
    for (const junk of [null, 7, "x", [1], { kind: "hint" }]) h.emit("hint", junk);
    await until(h, (x) => x.hint);
    await sleep(150);
    assert.strictEqual(cur(h).coach.me.free.hint, 2, "five asks on one board: one hint");
    for (const caps of ["coach", { coach: true }, ["Coach"], [["coach"]], null]) {
      const s = client();
      s.emit("create", { name: "Odd", playerId: pid("o"), caps, coach: { hint: 5 } });
      const r = await until(s, (x) => x.players.length === 1);
      assert.ok(!("coach" in r), "caps " + JSON.stringify(caps));
      s.close();
    }
    h.emit("coachUsed", { kind: "hint", left: 50 }); h.emit("puzzleCoach", {}); await sleep(80);   // not messages the server takes
    assert.strictEqual(cur(h).status, "playing");
  });
}

/* ---------- puzzles (the day's is DAILY_PUZZLE here: one with four moves to find) ---------- */
const PZ = "0wIxO";
async function nextPuzzle(s, event, payload) {
  const n = s.puzzles.length, r0 = s.refusals.length;
  s.emit(event, payload);
  await wait(() => s.puzzles.length > n || s.refusals.length > r0, 4000, "an answer to " + event);
  return s.puzzles.length > n ? s.puzzles[s.puzzles.length - 1] : null;
}
async function wirePuzzles() {
  console.log("coach: puzzles");
  const line = Puzzles.BY_ID.get(PZ).moves;
  const from = (i) => line[i].slice(0, 2);
  const X = pid("pz");
  let a, game;
  await test("a puzzle as the test wants it: four moves to find", () => { assert.strictEqual(line.length, 8); });
  await test("an old app's puzzle: hints without end, the square always sent, nothing new", async () => {
    const o = client();
    let p = await nextPuzzle(o, "puzzle", { daily: true, rating: 1400, coach: { hint: 5 }, playerId: pid("old") });
    assert.strictEqual(p.id, PZ);
    assert.strictEqual(p.hintFrom, from(1)); assert.ok(!("coach" in p));
    for (let i = 0; i < 6; i++) { p = await nextPuzzle(o, "puzzleHint"); assert.strictEqual(p.hint, true); assert.strictEqual(p.hintFrom, from(1)); assert.ok(!("coach" in p)); }
    o.emit("coachStock", { hint: 3 }); await sleep(120);
    assert.strictEqual(o.used.length + o.refusals.length + o.pzCoach.length, 0);
  });
  await test("a coach app's puzzle: `coach` with every answer, and the square only for a hint it was given", async () => {
    a = client();
    const p = await nextPuzzle(a, "puzzle", { daily: true, rating: 1400, caps: ["coach"], coach: { hint: 0, takeback: 0, review: 0 }, playerId: X });
    assert.strictEqual(p.id, PZ); assert.strictEqual(p.status, "playing");
    assert.strictEqual(p.hintFrom, null);
    game = p.coach.game;
    assert.ok(/^pz[0-9a-f]{8}$/.test(game), "a puzzle's own id: " + game);
    assert.deepStrictEqual(p.coach, { game, on: true, free: { hint: 3 }, me: { free: { hint: 3 }, stock: { hint: 0, takeback: 0, review: 0 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: false } });
  });
  await test("three free hints a puzzle; the same move's hint again costs nothing", async () => {
    for (let i = 0; i < 3; i++) {
      let p = await nextPuzzle(a, "puzzleHint");
      assert.strictEqual(p.hint, true); assert.strictEqual(p.hintFrom, from(1 + 2 * i));
      assert.strictEqual(p.coach.me.free.hint, 2 - i);
      p = await nextPuzzle(a, "puzzleHint");
      assert.strictEqual(p.hintFrom, from(1 + 2 * i)); assert.strictEqual(p.coach.me.free.hint, 2 - i);
      p = await nextPuzzle(a, "puzzleMove", { uci: line[1 + 2 * i] });
      assert.strictEqual(p.status, "playing");
      assert.strictEqual(p.hintFrom, null, "the next move was not hinted");
      assert.strictEqual(p.coach.me.free.hint, 2 - i);
    }
    assert.strictEqual(a.used.length, 0); assert.strictEqual(a.refusals.length, 0);
  });
  await test("then a hint needs stock: refused without, coachStock answered by puzzleCoach, a paid one says coachUsed", async () => {
    assert.strictEqual(await nextPuzzle(a, "puzzleHint"), null);
    assert.deepStrictEqual(lastRefusal(a), { code: "coach", message: "No hints left. Get more in the Shop.", op: "puzzleHint" });
    a.emit("coachStock", { hint: 2, takeback: 0, review: 0, seen: { game, hint: 0 } });
    await wait(() => a.pzCoach.length === 1, 3000, "puzzleCoach");
    assert.strictEqual(a.pzCoach[0].id, PZ);
    assert.deepStrictEqual(a.pzCoach[0].coach.me, { free: { hint: 0 }, stock: { hint: 2, takeback: 0, review: 0 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: false });
    let p = await nextPuzzle(a, "puzzleHint");
    assert.deepStrictEqual(a.used, [{ kind: "hint", left: 1, game, puzzle: PZ }]);
    assert.strictEqual(p.hint, true); assert.strictEqual(p.hintFrom, from(7));
    assert.deepStrictEqual(p.coach.me, { free: { hint: 0 }, stock: { hint: 1, takeback: 0, review: 0 }, spent: { hint: 1, takeback: 0, review: 0 }, plus: false });
    p = await nextPuzzle(a, "puzzleHint");
    assert.strictEqual(p.hintFrom, from(7)); assert.strictEqual(a.used.length, 1);
    p = await nextPuzzle(a, "puzzleMove", { uci: line[7] });
    assert.strictEqual(p.status, "solved"); assert.strictEqual(p.ratingDelta, 0, "solved with a hint: no rating, as ever");
    const n = a.puzzles.length;
    a.emit("puzzleHint"); await sleep(150);
    assert.strictEqual(a.puzzles.length, n, "nothing to hint at once solved"); assert.strictEqual(a.refusals.length, 1);
  });
  await test("the same puzzle opened again: no three more, the moves hinted before are free, a use is counted once (seen)", async () => {
    const b = client();   // another connection of the same player
    let p = await nextPuzzle(b, "puzzle", { daily: true, rating: 1400, caps: ["coach"], coach: { hint: 2 }, playerId: X });   // the app had not counted the use
    assert.strictEqual(p.coach.game, game);
    assert.deepStrictEqual(p.coach.me, { free: { hint: 0 }, stock: { hint: 1, takeback: 0, review: 0 }, spent: { hint: 1, takeback: 0, review: 0 }, plus: false });
    assert.strictEqual(p.hintFrom, null);
    p = await nextPuzzle(b, "puzzle", { daily: true, rating: 1400, caps: ["coach"], coach: { hint: 1, seen: { game, hint: 1 } }, playerId: X });   // and now it has
    assert.strictEqual(p.coach.me.stock.hint, 1);
    p = await nextPuzzle(b, "puzzleHint");
    assert.strictEqual(p.hintFrom, from(1)); assert.strictEqual(b.used.length, 0);
    assert.strictEqual(p.coach.me.stock.hint, 1);
  });
  await test("another player's puzzle is their own count; so is a connection's that says no player", async () => {
    const c = client();
    let p = await nextPuzzle(c, "puzzle", { daily: true, rating: 1400, caps: ["coach"], coach: { hint: 0 }, playerId: pid("pz") });
    assert.strictEqual(p.coach.me.free.hint, 3); assert.notStrictEqual(p.coach.game, game);
    const d = client();
    p = await nextPuzzle(d, "puzzle", { daily: true, rating: 1400, caps: ["coach"] });
    assert.strictEqual(p.coach.me.free.hint, 3);
    p = await nextPuzzle(d, "puzzleHint");
    assert.strictEqual(p.coach.me.free.hint, 2);
    p = await nextPuzzle(d, "puzzle", { daily: true, rating: 1400, caps: ["coach"], playerId: { $ne: 1 } });
    assert.strictEqual(p.coach.me.free.hint, 2, "opening it again does not hand out three more");
  });
  await test("Plus: a puzzle's hints have no limit and nothing is spent", async () => {
    const e = client();
    let p = await nextPuzzle(e, "puzzle", { daily: true, rating: 1400, plus: true, caps: ["coach"], coach: { hint: 1 }, playerId: pid("pz") });
    for (let i = 0; i < 4; i++) {
      p = await nextPuzzle(e, "puzzleHint");
      assert.strictEqual(p.hintFrom, from(1 + 2 * i));
      p = await nextPuzzle(e, "puzzleMove", { uci: line[1 + 2 * i] });
    }
    assert.strictEqual(p.status, "solved");
    assert.deepStrictEqual(p.coach.me, { free: { hint: 3 }, stock: { hint: 1, takeback: 0, review: 0 }, spent: { hint: 0, takeback: 0, review: 0 }, plus: true });
    assert.strictEqual(e.used.length + e.refusals.length, 0);
  });
}

async function main() {
  await scripted();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "gn-chess-coach-"));
  const own = (name, sub) => process.env[name] || path.join(data, sub);   // the caller's folder if it set one, else a scratch one
  const env = Object.assign({}, process.env, { PORT: String(PORT), START_WHITE: "host", BOT_MS: "5", AFK_MS: "5000", BOT_DEPTH: "1", REVIEW_MS: "40", BOT_LOG: "0",
    DAILY_PUZZLE: PZ, RANK_DIR: own("RANK_DIR", "ratings"), STATS_DIR: own("STATS_DIR", "stats"), PLUS_STATS_FILE: own("PLUS_STATS_FILE", "plus_stats.json") });
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "ignore" });
  await sleep(900);
  try {
    for (const part of [wireOldApp, wireHints, wireTakebacks, wirePeople, wireReview, wirePlusAndSeats, wirePuzzles]) {
      await part();
      for (const s of socks.splice(0)) s.close();
    }
  } catch (e) { failed++; console.log("  FAIL (the run stopped)\n    " + ((e && e.stack) || e)); }
  finally {
    for (const s of socks) s.close();
    srv.kill();
    await sleep(200);
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(`chess coach: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
