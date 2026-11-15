/* Bot soak (pacing round 1, 2026-11-01; not part of npm test, it takes minutes): a person's seat (Maia-2 at 1400, instantly)
   plays the bot at each level over a real socket, and every bot ply is timed from the state in which it became the bot's
   turn to the state that shows its move. Reports plies, p50, p95 and max per level.
     PORT=5441 node server.js     then:     node test/soak.js http://127.0.0.1:5441 easy,normal,hard,expert,master 200
   (expert and master are Plus rooms'. Never point it at 3111-3124.) */
const { io } = require("socket.io-client");
// The person's seat plays like a person of about 1400 (Maia-2), else at random.
const Maia = require("../maia"), G = require("../game");
async function humanMove(st) {
  if (Maia) { try { const c = new G.Chess(st.room.fen); const m = await Maia.move(c, { elo: 1400, temp: 0.8, timeoutMs: 8000 }); if (m && st.room.legal.includes(m)) return m; } catch (e) { /* random */ } }
  return st.room.legal[Math.floor(Math.random() * st.room.legal.length)];
}
const URL = process.argv[2] || "http://127.0.0.1:5441";
if (/:31(1[1-9]|2[0-4])\b/.test(URL)) { console.error("refusing " + URL + ": the live servers"); process.exit(2); }
const LEVELS = (process.argv[3] || "easy,normal,hard").split(",");
const TARGET = Number(process.argv[4] || 200);
const pct = (a, p) => { if (!a.length) return null; a = a.slice().sort((x, y) => x - y); const k = (a.length - 1) * p / 100, f = Math.floor(k), c = Math.min(f + 1, a.length - 1); return Math.round(a[f] + (a[c] - a[f]) * (k - f)); };

async function level(name) {
  const times = [];
  let games = 0;
  while (times.length < TARGET) {
    games++;
    const a = io(URL, { transports: ["websocket"], forceNew: true });
    let last = null, waiters = [];
    a.on("state", (st) => { last = st; waiters = waiters.filter((w) => !w(st)); });
    const until = (pred, ms = 15000) => new Promise((res, rej) => {
      if (last && pred(last)) return res(last);
      const t = setTimeout(() => rej(new Error("timeout waiting (" + name + ")")), ms);
      waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
    });
    try {
      a.emit("create", { name: "Ava", playerId: "soak_" + name + "_" + Math.random().toString(36).slice(2), plus: true });
      await until((s) => s.room.players.length === 1);
      a.emit("settings", { level: name, tc: "none" });
      await until((s) => s.room.level === name);
      a.emit("addBot");
      await until((s) => s.room.players.length === 2);
      a.emit("start");
      let st = await until((s) => s.room.status === "playing");
      const me = st.mySeat;
      let botSince = null, botMv = st.room.lastMove ? st.room.lastMove.mv : 0;
      while (true) {
        st = last;
        if (st.room.status !== "playing") break;
        if (st.room.turn === me) {
          const before = st.room.lastMove ? st.room.lastMove.mv : 0;
          a.emit("move", { uci: await humanMove(st) });
          await until((s) => s.room.status !== "playing" || (s.room.lastMove && s.room.lastMove.mv > before));
          botSince = Date.now();
        } else {
          if (botSince === null) botSince = Date.now();   // the bot opens the game
          const before = st.room.lastMove ? st.room.lastMove.mv : 0;
          const nx = await until((s) => s.room.status !== "playing" || (s.room.lastMove && s.room.lastMove.mv > before), 20000);
          times.push(Date.now() - botSince);
          botSince = null;
        }
      }
    } catch (e) {
      console.error(name, "game", games, "error:", e.message);
    } finally { a.close(); }
  }
  return times;
}

(async () => {
  const out = await Promise.all(LEVELS.map(async (n) => [n, await level(n)]));
  console.log("level   plies   p50   p95   max  (ms per bot ply, state-to-state)");
  for (const [n, t] of out) console.log(n.padEnd(8), String(t.length).padEnd(6), String(pct(t, 50)).padEnd(5), String(pct(t, 95)).padEnd(5), Math.max(...t), " >3000ms:", t.filter((x) => x > 3000).length);
  process.exit(0);
})();
