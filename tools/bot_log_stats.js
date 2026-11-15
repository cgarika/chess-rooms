/* The bots' plies as the server logs them (server.js logPly: one JSON line each, "bot":"ply"): how many, p50, p95 and max milliseconds, how each was
   decided, and the fallbacks with their reasons, per level.
       node tools/bot_log_stats.js <logfile> [more files...]        (or:  ... | node tools/bot_log_stats.js -)
   Exit 1 when a level's p95 is over 3000 ms or its max over 5000 (chess r1's bar: "p95 under 3 s, max under 5 s"). */
const fs = require("fs");
const files = process.argv.slice(2);
const text = files.length === 0 || files[0] === "-" ? fs.readFileSync(0, "utf8") : files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const by = {};
for (const line of text.split("\n")) {
  if (!line.includes('"bot":"ply"')) continue;
  let o; try { o = JSON.parse(line.slice(line.indexOf("{"))); } catch (e) { continue; }
  const L = (by[o.level] = by[o.level] || { ms: [], how: {}, engine: {}, falls: [] });
  L.ms.push(o.ms); L.how[o.how] = (L.how[o.how] || 0) + 1; L.engine[o.engine] = (L.engine[o.engine] || 0) + 1;
  if (o.fallback) L.falls.push(o.fallback);
}
const pct = (a, p) => { a = a.slice().sort((x, y) => x - y); const k = (a.length - 1) * p / 100, f = Math.floor(k), c = Math.min(f + 1, a.length - 1); return Math.round(a[f] + (a[c] - a[f]) * (k - f)); };
let bad = false, total = 0;
console.log("level     plies   p50   p95   max   engines / how");
for (const [level, L] of Object.entries(by)) {
  const p95 = pct(L.ms, 95), max = Math.max(...L.ms);
  total += L.ms.length;
  if (p95 > 3000 || max > 5000) bad = true;
  console.log(level.padEnd(9), String(L.ms.length).padEnd(6), String(pct(L.ms, 50)).padEnd(5), String(p95).padEnd(5), String(max).padEnd(5), JSON.stringify(L.engine), JSON.stringify(L.how), L.falls.length ? "fallbacks: " + [...new Set(L.falls)].join("; ") : "");
}
console.log(total + " plies" + (bad ? "  OVER THE BAR" : "  within the bar (p95 < 3 s, max < 5 s)"));
process.exit(bad ? 1 : 0);
