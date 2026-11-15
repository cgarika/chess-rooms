/* A game review off the rooms' thread: given { moves, fen, budgetMs }, posts { progress } as it goes and then
   { done: { plies, accuracy, engine } } (or { error }). Stockfish judges it (sf.js); without its engine files (or with
   REVIEW_ENGINE=own), review.js's own search does. */
"use strict";
const { parentPort, workerData } = require("worker_threads");
const { review, reviewWith } = require("./review");
const Sf = require("./sf");

const progress = (i, n) => parentPort.postMessage({ progress: Math.round((100 * i) / n) });

(async () => {
  try {
    if (Sf.available() && process.env.REVIEW_ENGINE !== "own") {
      const sf = await Sf.open(workerData.budgetMs);
      const result = await reviewWith(sf.search, workerData.moves, { fen: workerData.fen, progress });
      sf.quit();
      parentPort.postMessage({ done: { ...result, engine: "stockfish" } });
    } else {
      const result = review(workerData.moves, { fen: workerData.fen, budgetMs: workerData.budgetMs, progress });
      parentPort.postMessage({ done: { ...result, engine: "own" } });
    }
  } catch (e) {
    parentPort.postMessage({ error: String((e && e.message) || e) });
  }
  // The engine keeps the event loop alive: the worker ends once its answer is on its way.
  setImmediate(() => process.exit(0));
})();
