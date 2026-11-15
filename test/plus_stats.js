/* Chess: GameNest Plus's counters (2026-10-18) on their own and over HTTP: known events counted by day (and by game),
   anything else refused, no ids kept, a flood from one address held back, the summary's totals and rates. */
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 3298);
let passed = 0;
const ok = (n) => { passed++; console.log("  ok " + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("plus stats: the module");
  const file = path.join(os.tmpdir(), `plus_stats_${process.pid}.json`);
  process.env.PLUS_STATS_FILE = file;
  const S = require("../plus_stats");
  S._reset();
  const d1 = new Date("2026-10-18T10:00:00Z"), d2 = new Date("2026-10-19T10:00:00Z");
  assert.ok(S.count("page_open", null, d1) && S.count("page_open", "chess", d1) && S.count("purchase_ok", "chess", d1));
  assert.ok(S.count("page_open", null, d2) && S.count("get_plus_tap", null, d2));
  assert.ok(!S.count("steal_data", null, d1) && !S.count("page_open; drop", null, d1));
  const sum = S.summary();
  assert.deepStrictEqual(sum.days.map((x) => x.day), ["2026-10-19", "2026-10-18"]);
  assert.strictEqual(sum.totals.page_open, 3);
  assert.strictEqual(sum.days[1]["purchase_ok:chess"], 1);
  assert.strictEqual(sum.conversion.buyPerPageOpen, 33.3);
  ok("known events counted a day (and a game); anything else refused; totals and the buy rate");
  S.flush();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(saved["2026-10-18"] && !JSON.stringify(saved).match(/player|ip|id"/));
  ok("saved as counts only: no player, no address");
  fs.unlinkSync(file);

  console.log("plus stats: over HTTP");
  const file2 = path.join(os.tmpdir(), `plus_stats_http_${process.pid}.json`);
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(PORT), BASE_PATH: "/chess", PLUS_STATS_FILE: file2 }, stdio: "ignore" });
  try {
    await sleep(1500);
    const post = (body) => fetch(`http://127.0.0.1:${PORT}/chess/plus-stats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const a = await post({ event: "page_open", game: "ludo" });
    const b = await post({ event: "who_knows" });
    assert.deepStrictEqual([a.status, a.json.ok, b.status, b.json.ok], [200, true, 200, false]);
    ok("an event counted, an unknown one not");
    const flood = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => post({ event: "upsell_shown" })));
    assert.ok(flood.some((r) => r.status === 429), "a flood from one address is held back");
    ok("eight at once from one address: the rest held back (429)");
    const s = await (await fetch(`http://127.0.0.1:${PORT}/chess/plus-stats/summary`)).json();
    assert.ok(s.totals.page_open >= 1 && s.days[0]["page_open:ludo"] >= 1);
    ok("the summary reads it back, by game too");
  } finally {
    srv.kill();
    try { fs.unlinkSync(file2); } catch (e) {}
  }
  console.log(`plus stats: all ${passed} passed`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
