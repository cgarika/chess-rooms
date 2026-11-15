/* Preloaded (node -r) by test/pacing.js: the bots' engines made to misbehave, so the watchdog can be seen to play.
   STUB = hang (never answers), reject (a rejected promise), throw (throws at once), illegal (a move that is not legal),
   late (answers after 3.5 s), slow (answers after 1.0 s: in time, so its move is the one played). */
const path = require("path");
const Maia = require(path.join(__dirname, "..", "maia"));
const Sf = require(path.join(__dirname, "..", "sf_bot"));
const mode = process.env.STUB || "";
const make = (good) => (...args) => {
  switch (mode) {
    case "hang": return new Promise(() => {});
    case "reject": return Promise.reject(new Error("stub: the engine failed"));
    case "throw": throw new Error("stub: the engine threw");
    case "illegal": return Promise.resolve("a1a1");
    case "late": return new Promise((res) => setTimeout(() => res(null), 3500));
    case "slow": return new Promise((res) => setTimeout(() => res(good), 1000));
    default: return Promise.resolve(good);
  }
};
if (mode) {
  Maia.move = make("e7e5");
  Sf.move = make("e7e5");
}
