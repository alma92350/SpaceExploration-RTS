/* ============================================================
   Transient visual effects (attack tracers, death flashes, under-attack
   pings): purely cosmetic, client-side, and short-lived, so they live
   here instead of in engine/ state — the sim's fixed-timestep tick
   never reads or needs to know about them.

   main.js feeds this each render frame by draining state.events (the
   same sim event queue that also drives sound.js), and render.js reads
   activeEffects() each frame to draw whatever's still alive. Timing is
   wall-clock (performance.now()), not sim time, since these should
   animate at real display speed regardless of simulation rate.
   ============================================================ */

"use strict";

const TRACER_LIFETIME_MS = 120;
const DEATH_LIFETIME_MS = 280;
const PING_LIFETIME_MS = 3000;

let tracers = [];
let deaths = [];
let pings = [];

export function addTracer(fromX, fromY, toX, toY, unitType) {
  tracers.push({ fromX, fromY, toX, toY, unitType, born: performance.now() });
}

export function addDeathFlash(x, y) {
  deaths.push({ x, y, born: performance.now() });
}

// A longer-lived pulsing marker for the under-attack alert, so the
// player can find the fight on the minimap (or the main view, if it's
// on-screen) even after the alert banner itself has faded.
export function addUnderAttackPing(x, y) {
  pings.push({ x, y, born: performance.now() });
}

// Called once per render frame: prunes expired effects and returns the
// survivors with a 0 (just spawned) -> 1 (about to vanish) age fraction
// baked in, so render.js can fade/animate them without needing to know
// the lifetime constants itself.
export function activeEffects() {
  const now = performance.now();
  tracers = tracers.filter(t => now - t.born < TRACER_LIFETIME_MS);
  deaths = deaths.filter(d => now - d.born < DEATH_LIFETIME_MS);
  pings = pings.filter(p => now - p.born < PING_LIFETIME_MS);
  return {
    tracers: tracers.map(t => ({ ...t, age: (now - t.born) / TRACER_LIFETIME_MS })),
    deaths: deaths.map(d => ({ ...d, age: (now - d.born) / DEATH_LIFETIME_MS })),
    pings: pings.map(p => ({ ...p, age: (now - p.born) / PING_LIFETIME_MS })),
  };
}

// Cleared on a fresh game start so effects from a previous match don't
// bleed into the next one's first frame.
export function resetEffects() {
  tracers = [];
  deaths = [];
  pings = [];
}
