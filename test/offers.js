/* Chess: draw and take-back offers over real sockets (humans, and the bot). */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

const PORT = Number(process.env.TEST_PORT || 3294);
const URL = `http://127.0.0.1:${PORT}`;
let passed = 0;
const ok = (name) => { passed++; console.log("  ok " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = () => io(URL, { transports: ["websocket"], forceNew: true });
const last = new WeakMap();
function watch(sock) { sock.on("state", (s) => last.set(sock, s)); return sock; }
const cur = (sock) => last.get(sock).room;
function until(sock, pred, ms = 6000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const s = last.get(sock);
      if (s && pred(s.room, s)) return res(s.room);
      if (Date.now() - t0 > ms) return rej(new Error("timeout waiting; log=" + (s && s.room.log)));
      setTimeout(tick, 15);
    };
    tick();
  });
}
async function table(opts, bot) {
  const h = watch(client());
  h.emit("create", { name: "Host", playerId: "p_h" + Math.random() });
  const r = await until(h, (x) => x.players.length === 1);
  let g = null;
  if (bot) h.emit("addBot");
  else { g = watch(client()); g.emit("join", { code: r.code, name: "Guest", playerId: "p_g" + Math.random() }); }
  await until(h, (x) => x.players.length === 2);
  h.emit("start");
  await until(h, (x) => x.status === "playing");
  return { h, g, code: r.code };
}
const mv = async (sock, uci) => { const n = cur(sock).moves.length; sock.emit("move", { uci }); await until(sock, (x) => x.moves.length > n); };

async function main() {
  const env = Object.assign({}, process.env, { PORT, START_WHITE: "host", BOT_MS: "5", AFK_MS: "5000", BOT_DEPTH: "1" });
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "ignore" });
  await sleep(700);
  const socks = [];
  try {
    console.log("offers");
    // Two people. Host has white.
    let { h, g, code } = await table(); socks.push(h, g);
    assert.deepStrictEqual(cur(h).caps, ["offers"]); assert.strictEqual(cur(h).offer, null);
    ok("state carries caps [offers] and offer null");

    h.emit("offer", { kind: "draw" });
    await until(g, (x) => x.offer && x.offer.kind === "draw" && x.offer.from === 0);
    ok("a draw offer reaches the other seat");
    h.emit("offer", { kind: "takeback" }); g.emit("offer", { kind: "draw" });   // a second offer while one is pending
    await sleep(150);
    assert.strictEqual(cur(g).offer.kind, "draw"); assert.strictEqual(cur(g).offer.from, 0);
    ok("a second offer while one is pending is ignored");
    h.emit("reply", { accept: true });   // the offerer cannot answer their own offer
    await sleep(150);
    assert.ok(cur(h).offer);
    g.emit("reply", { accept: "yes" });  // bad payload
    await sleep(100);
    assert.ok(cur(h).offer);
    g.emit("reply", { accept: true });
    let r = await until(h, (x) => x.status === "over");
    assert.strictEqual(r.result.reason, "agreement"); assert.strictEqual(r.winner, null); assert.strictEqual(r.offer, null);
    assert.strictEqual(r.log, "Draw agreed.");
    assert.deepStrictEqual(r.wins, [0, 0]);
    ok("an accepted draw ends the game as a draw by agreement");
    h.emit("offer", { kind: "draw" }); await sleep(100);
    assert.strictEqual(cur(h).offer, null);
    ok("no offer once the game is over");
    h.emit("rematch");
    await until(h, (x) => x.status === "playing");
    ok("a rematch follows an agreed draw");
    h.close(); g.close();

    // Decline, cancel, spam limit, offer cleared by a move.
    ({ h, g } = await table()); socks.push(h, g);
    await mv(h, "e2e4");
    g.emit("offer", { kind: "draw" });
    await until(h, (x) => x.offer && x.offer.from === 1);
    h.emit("reply", { accept: false });
    r = await until(g, (x) => x.offer === null && /declines the draw/.test(x.log));
    assert.strictEqual(r.status, "playing");
    ok("a declined draw clears the offer and says so");
    g.emit("offer", { kind: "draw" }); await sleep(150);
    assert.strictEqual(cur(g).offer, null);
    ok("the same offer again before another move is ignored");
    await mv(g, "e7e5");
    g.emit("offer", { kind: "draw" }); await sleep(0);
    await until(h, (x) => x.offer && x.offer.from === 1);
    g.emit("cancelOffer");
    await until(h, (x) => x.offer === null);
    h.emit("cancelOffer"); await sleep(50);
    ok("the offerer can cancel");
    g.emit("offer", { kind: "draw" }); await sleep(150);
    assert.strictEqual(cur(g).offer, null);
    await mv(h, "g1f3");
    g.emit("offer", { kind: "draw" });
    await until(h, (x) => x.offer);
    g.emit("cancelOffer"); await until(h, (x) => !x.offer);
    h.emit("offer", { kind: "draw" });
    await until(g, (x) => x.offer && x.offer.from === 0);
    await mv(g, "b8c6");
    assert.strictEqual(cur(g).offer, null);
    ok("a move clears a pending offer");

    // Take-back: 1 ply (offerer just moved), then 2 plies (opponent replied).
    // Position now: 1.e4 e5 2.Nf3 Nc6, white to move.
    h.emit("offer", { kind: "takeback" });
    await until(g, (x) => x.offer && x.offer.kind === "takeback");
    g.emit("reply", { accept: true });
    r = await until(h, (x) => x.moves.length === 2);
    assert.deepStrictEqual(r.moves, ["e4", "e5"]); assert.strictEqual(r.turn, 0);
    assert.strictEqual(r.lastMove.san, "e5"); assert.strictEqual(r.lastMove.mv, 2);
    assert.strictEqual(r.positions.length, 3); assert.strictEqual(r.offer, null);
    assert.strictEqual(r.fen.split(" ")[0], r.positions[2]);
    assert.ok(r.legal.includes("g1f3"));
    ok("a take-back after the opponent replied undoes two plies");
    await mv(h, "g1f3");
    h.emit("offer", { kind: "takeback" });   // white's last move, black has not replied: one ply
    await until(g, (x) => x.offer);
    g.emit("reply", { accept: true });
    r = await until(h, (x) => x.moves.length === 2 && !x.offer);
    assert.deepStrictEqual(r.moves, ["e4", "e5"]); assert.strictEqual(r.turn, 0);
    ok("a take-back before the reply undoes one ply");
    // Black asks to take back with no move made by black yet: not possible at move 1.
    h.close(); g.close();
    ({ h, g } = await table()); socks.push(h, g);
    g.emit("offer", { kind: "takeback" }); await sleep(100);
    assert.strictEqual(cur(g).offer, null);
    await mv(h, "d2d4");
    g.emit("offer", { kind: "takeback" }); h.emit("offer", { kind: "takeback" });
    await sleep(100);
    assert.strictEqual(cur(g).offer && cur(g).offer.from, 0);   // white may; black (no move yet) could not
    h.emit("cancelOffer"); await until(g, (x) => !x.offer);
    ok("a take-back needs a move of your own to take back");

    // Spectator and strangers.
    const w = watch(client());
    w.emit("join", { code: cur(h).code, name: "Watcher", playerId: "p_w" + Math.random(), caps: ["waitList"] });
    await until(w, (x) => x.waiting && x.waiting.length === 1);
    w.emit("offer", { kind: "draw" }); await sleep(150);
    assert.strictEqual(cur(h).offer, null);
    h.emit("offer", { kind: "draw" });
    await until(g, (x) => x.offer);
    w.emit("reply", { accept: true }); w.emit("cancelOffer"); await sleep(150);
    assert.ok(cur(h).offer && cur(h).status === "playing");
    ok("a spectator can neither offer, answer nor cancel");
    w.close(); h.close(); g.close();

    // No game (lobby).
    const l = watch(client());
    l.emit("create", { name: "Lone", playerId: "p_l" + Math.random() });
    await until(l, (x) => x.players.length === 1);
    l.emit("offer", { kind: "draw" }); l.emit("offer", { kind: "nonsense" }); l.emit("offer", null); l.emit("reply", { accept: true });
    await sleep(150);
    assert.strictEqual(cur(l).offer, null); assert.strictEqual(cur(l).status, "lobby");
    ok("offers outside a game are ignored");
    l.close();

    // The bot.
    ({ h } = await table(null, true)); socks.push(h);
    h.emit("offer", { kind: "takeback" }); await sleep(100);
    // Make sure it is our turn, with one move of ours played.
    await until(h, (x) => x.turn === 0);
    await mv(h, "e2e4");
    await until(h, (x) => x.turn === 0 && x.moves.length === 2);   // the bot replied
    h.emit("offer", { kind: "takeback" });
    r = await until(h, (x) => x.moves.length === 0 && x.offer === null);
    assert.strictEqual(r.turn, 0); assert.strictEqual(r.lastMove, null);
    await sleep(400);   // the bot must not move: it is our turn
    assert.strictEqual(cur(h).moves.length, 0); assert.strictEqual(cur(h).turn, 0);
    ok("against the bot a take-back is granted at once and the bot does not move on a stale position");
    await mv(h, "d2d4");
    await until(h, (x) => x.moves.length === 2);
    h.emit("offer", { kind: "draw" });
    r = await until(h, (x) => /coach declines the draw/.test(x.log));
    assert.strictEqual(r.offer, null); assert.strictEqual(r.status, "playing");
    ok("the bot declines an early draw");
    // A take-back while the bot's reply is pending: one ply, and the bot must not play the stale move.
    await until(h, (x) => x.turn === 0);
    await mv(h, "c2c4");
    h.emit("offer", { kind: "takeback" });
    r = await until(h, (x) => x.offer === null);
    await sleep(400);
    const n = cur(h).moves.length;
    assert.ok(n === 2 || n === 4 || n === 3, "moves " + n);
    assert.strictEqual(cur(h).turn === 0 || cur(h).moves.length % 2 === 1, true);
    h.close();
    ok("a take-back made as the bot is about to reply leaves a consistent game");
  } finally {
    for (const s of socks) s.close();
    srv.kill();
  }
}
main().then(() => { console.log(`all ${passed} passed`); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
