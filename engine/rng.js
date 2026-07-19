/* ============================================================
   The sim's one sanctioned source of randomness: a small, fast, seedable
   PRNG. Passing a mulberry32(seed) into createGameState makes a whole match
   reproducible from that one number — the foundation for shareable map seeds
   today and replays/netcode later. The engine uses NO other randomness (a
   determinism-guard test enforces it), so "same seed ⇒ same game".
   ============================================================ */

"use strict";

// mulberry32: 32-bit state, good distribution, identical output across JS
// engines for the same seed. Returns a function producing floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
