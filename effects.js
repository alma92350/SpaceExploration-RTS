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
const FIREWORK_LIFETIME_MS = 1500;

let tracers = [];
let deaths = [];
let pings = [];
let fireworks = [];

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

// A celebratory burst show for Odyssey progress milestones (engine/galaxy.js). Screen-space,
// so it plays over the whole viewport regardless of which world you're on. `bursts` shells go
// off staggered in time at random points in the upper screen; each is a ring of sparks that fly
// out, arc down under gravity, and fade. Purely cosmetic + client-side — Math.random/now are
// fine here (this never touches the deterministic sim). Positions are normalized 0..1 of the
// viewport, scaled at draw time so a resize can't misplace an in-flight shell.
export function addFireworks(bursts = 5) {
  const now = performance.now();
  for (let i = 0; i < bursts; i++) {
    const base = Math.floor(Math.random() * 360);
    const n = 22 + Math.floor(Math.random() * 16);
    const parts = [];
    for (let p = 0; p < n; p++) {
      const a = (p / n) * Math.PI * 2 + Math.random() * 0.25;
      const spd = 0.05 + Math.random() * 0.09;                 // fraction of viewport height per unit age
      parts.push({ a, spd, hue: (base + Math.random() * 44 - 22 + 360) % 360 });
    }
    fireworks.push({
      cx: 0.18 + Math.random() * 0.64,                         // clear of the extreme edges
      cy: 0.16 + Math.random() * 0.40,                         // upper portion of the screen
      parts,
      born: now + i * 240,                                     // staggered launches → a sustained show
    });
  }
}

// Live fireworks with a 0→1 age baked in: a shell whose staggered launch hasn't arrived yet
// (age<0) is withheld, one still mid-flight is returned, spent ones are pruned.
export function activeFireworks() {
  const now = performance.now();
  fireworks = fireworks.filter(f => now - f.born < FIREWORK_LIFETIME_MS);
  return fireworks
    .map(f => ({ ...f, age: (now - f.born) / FIREWORK_LIFETIME_MS }))
    .filter(f => f.age >= 0);
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
  fireworks = [];
}
