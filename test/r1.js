/* Chess r1 (2026-11-02): the first game against the coach is the person's with White (the board then has a1 at the bottom left on the phone), a
   rematch swaps the colours, and every bot ply is one JSON line in the server's log with its engine, how it was decided, and how long it took
   (BOT_LOG=0 mutes it). Own servers on TEST_PORT.. (default 5531, two ports); never 3111-3124. */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

const PORT = Number(process.env.TEST_PORT || 5531);
if (PORT >= 3111 && PORT <= 3124) { console.error("refusing " + PORT + ": the live servers"); process.exit(2); }
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("  ok " + name); };

const boot = async (port, env) => {
  const lines = [];
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: port, AFK_MS: "60000", NO_WARM: "1", BOT_MS: "5" }, env), stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  await new Promise((r) => setTimeout(r, 900));
  return { child, lines };
};
const client = (port) => {
  const a = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true });
  const c = { a, last: null, waiters: [] };
  a.on("state", (st) => { c.last = st; for (const w of c.waiters.slice()) w(st); });
  c.until = (pred, ms = 6000) => new Promise((res, rej) => {
    if (c.last && pred(c.last)) return res(c.last);
    const t = setTimeout(() => rej(new Error(`no matching state in ${ms} ms`)), ms);
    const w = (st) => { if (pred(st)) { clearTimeout(t); c.waiters.splice(c.waiters.indexOf(w), 1); res(st); } };
    c.waiters.push(w);
  });
  return c;
};
const botGame = async (c, name) => {
  c.a.emit("create", { name: "Ava", playerId: "p_r1_" + name + Math.random().toString(36).slice(2) });
  await c.until((s) => s.room.players.length === 1);
  c.a.emit("settings", { level: "easy", tc: "none" });
  c.a.emit("addBot");
  await c.until((s) => s.room.players.length === 2);
  c.a.emit("start");
  return c.until((s) => s.room.status === "playing");
};

(async () => {
  console.log("chess r1: colours");
  const { child, lines } = await boot(PORT, {});
  try {
    await ok("the first game against the coach is the person's with White, every time", async () => {
      for (let i = 0; i < 12; i++) {
        const c = client(PORT);
        try { const st = await botGame(c, "w" + i); assert.strictEqual(st.room.white, st.mySeat, "game " + i + ": white is seat " + st.room.white + ", we are " + st.mySeat); assert.strictEqual(st.room.turn, st.mySeat, "and we move first"); }
        finally { c.a.close(); }
      }
    });
    await ok("a rematch swaps the colours (the coach has White, and moves first)", async () => {
      const c = client(PORT);
      try {
        const st = await botGame(c, "swap");
        c.a.emit("resign");
        await c.until((s) => s.room.status === "over");
        c.a.emit("rematch");
        const again = await c.until((s) => s.room.status === "playing");
        assert.notStrictEqual(again.room.white, again.mySeat, "the second game: the coach has White");
        assert.notStrictEqual(again.room.turn, again.mySeat, "and moves first");
        void st;
      } finally { c.a.close(); }
    });
    await ok("a bot ply is one JSON log line with its engine, how it came and its milliseconds", async () => {
      const c = client(PORT);
      try {
        const st = await botGame(c, "log");
        c.a.emit("move", { uci: "e2e4" });
        await c.until((s) => s.room.lastMove && s.room.lastMove.mv >= 2, 8000);
        await new Promise((r) => setTimeout(r, 200));
        const plies = lines.filter((l) => l.includes('"bot":"ply"')).map((l) => JSON.parse(l));
        assert.ok(plies.length >= 1, "a ply line in " + lines.length + " lines of log");
        const p = plies[plies.length - 1];
        assert.strictEqual(p.level, "easy");
        assert.ok(["maia2", "stockfish", "negamax"].includes(p.engine), p.engine);
        assert.ok(["engine", "watchdog", "classic", "fallback", "random"].includes(p.how), p.how);
        assert.ok(Number.isFinite(p.ms) && p.ms >= 0 && p.ms < 5000, "ms " + p.ms);
        assert.strictEqual(p.ply, 2, "the second ply of the game");
        assert.strictEqual(p.san, st.room.lastMove ? st.room.lastMove.san : p.san);
      } finally { c.a.close(); }
    });
  } finally { child.kill(); }
  {
    const quiet = await boot(PORT + 1, { BOT_LOG: "0" });
    try {
      await ok("BOT_LOG=0 keeps the log quiet", async () => {
        const c = client(PORT + 1);
        try { await botGame(c, "quiet"); c.a.emit("move", { uci: "e2e4" }); await c.until((s) => s.room.lastMove && s.room.lastMove.mv >= 2, 8000); await new Promise((r) => setTimeout(r, 200)); assert.strictEqual(quiet.lines.filter((l) => l.includes('"bot":"ply"')).length, 0); }
        finally { c.a.close(); }
      });
    } finally { quiet.child.kill(); }
  }
  console.log(`${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
