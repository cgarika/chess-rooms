/* The coach's stock (2026-11-13): hints, take-backs and review tickets a player bought with coins.

   The rules, all of them the server's (the app is never trusted with one):
     - the coach helps only in a game against a coach bot: never against a person (a hint is not given there, and a
       take-back there is the other player's to grant, as ever), and a game he helped in is not rated;
     - every game against a coach bot gives FREE.hint hints and FREE.takeback take-back; every puzzle gives
       PUZZLE_FREE.hint hints. After those each one costs one of the player's stock;
     - a review ticket opens ONE finished game's review for a player without Plus: spent once for that game, and asking
       again for the same game is free;
     - a player with GameNest Plus has no limits and nothing of theirs is ever spent;
     - nobody is told another player's stock: every word of it goes to its owner alone.

   The stock lives on the player's phone, as Power's does. The app says what it owns on create, join and quick
   (`coach: { hint, takeback, review, seen: { game, hint, takeback, review } }`) and again when it buys (`coachStock`,
   the same payload); the server clamps each count to 0..STOCK_MAX, counts every use itself, and tells the player alone
   (`coachUsed { kind, left, game }` at each paid use, and `coach.me` in their own state). `seen` is how many of THIS
   game's paid uses the app has already taken off its own count, so a stock said in the same moment as a use (a
   reconnect) is not counted twice.

   An app says it knows all this with "coach" in its caps. One that does not is treated exactly as before: its hints
   against a bot are free and unlimited, its take-backs go through `offer`, its review is Plus's, and it is sent nothing
   new. */
"use strict";

const CAP = "coach";
const KINDS = ["hint", "takeback", "review"];
const FREE = { hint: 3, takeback: 1 };   // what every game against a coach bot gives
const PUZZLE_FREE = { hint: 3 };         // what every puzzle gives
const STOCK_MAX = 99;
const LINES = {
  hint: "No hints left. Get more in the Shop.",
  takeback: "No take-backs left. Get more in the Shop.",
  review: "No review tickets left. Get more in the Shop.",
};

const zero = () => ({ hint: 0, takeback: 0, review: 0 });
function clean(x) {
  const o = zero();
  if (x && typeof x === "object" && !Array.isArray(x)) for (const k of KINDS) if (Number.isInteger(x[k])) o[k] = Math.min(STOCK_MAX, Math.max(0, x[k]));
  return o;
}
const knows = (caps) => Array.isArray(caps) && caps.includes(CAP);

/* What the app says it owns. Its count is the truth, less this game's paid uses it has not counted yet. An app that does
   not know the coach's stock owns nothing here. True when the stock was taken. */
function take(ck, sent, game) {
  if (!ck || !ck.knows || !sent || typeof sent !== "object" || Array.isArray(sent)) return false;
  const st = clean(sent);
  const seen = sent.seen && typeof sent.seen === "object" && game && sent.seen.game === game ? clean(sent.seen) : zero();
  for (const k of KINDS) ck.stock[k] = Math.max(0, st[k] - Math.max(0, ck.spent[k] - seen[k]));
  return true;
}

/* A seat's coach state: whether its app knows the stock, the stock as the app last said it, what this game has spent of
   it and how many of this game's free ones are used. */
function seat(caps, sent) {
  const ck = { knows: knows(caps), stock: zero(), spent: zero(), freeUsed: zero() };
  take(ck, sent, null);
  return ck;
}

/* A new game (or a new puzzle): nothing spent, every free one back. The stock stays as the server last counted it. */
function fresh(ck) { ck.spent = zero(); ck.freeUsed = zero(); return ck; }

/* One ask. Plus: given, nothing counted. Else a free one while the game has one, else one of the stock. Returns
   { paid: false } or { paid: true, left } when it was given, null when the player has none. */
function use(ck, kind, plus, free = FREE) {
  if (!ck || !ck.knows || !KINDS.includes(kind)) return null;
  if (plus) return { paid: false, plus: true };
  if (ck.freeUsed[kind] < (free[kind] || 0)) { ck.freeUsed[kind]++; return { paid: false }; }
  if (ck.stock[kind] < 1) return null;
  ck.stock[kind]--; ck.spent[kind]++;
  return { paid: true, left: ck.stock[kind] };
}

/* What a player alone is told about their own seat: the free ones left in this game, the stock and what this game spent. */
function me(ck, free = FREE) {
  const left = {};
  for (const k of Object.keys(free)) left[k] = Math.max(0, free[k] - ck.freeUsed[k]);
  return { free: left, stock: Object.assign({}, ck.stock), spent: Object.assign({}, ck.spent) };
}

module.exports = { CAP, KINDS, FREE, PUZZLE_FREE, STOCK_MAX, LINES, zero, clean, knows, take, seat, fresh, use, me };
