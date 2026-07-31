// @ts-check
/* ============================================================
   General collision separation: any two same-owner units — any type,
   however they got where they are (a shared rally point, a group order,
   two workers converging on one node, whatever) — get gently pushed
   apart the instant their bodies overlap. This runs every tick as a
   correction pass, independent of movement/orders, so it catches
   stacking from any source instead of needing a fix at each place an
   order gets assigned.

   Deliberately skips different-owner pairs: opposing units are meant to
   close to weapon range and stand there, not get shoved off it.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { queryNeighbors } from "./grid.js";
import { hashStr } from "./rng.js";
import { MAX_UNIT_RADIUS } from "./movement.js";

const PUSH_SPEED = 60;   // units/sec of separation at full overlap
const SEP_RADIUS = 2 * MAX_UNIT_RADIUS;   // two largest hulls touching — the widest possible minDist; derived, never stale

// A background world left to idle can pile up a same-owner army numbering in the
// hundreds, all crammed onto roughly the same rally point (nothing consumes an idle
// standing army). queryNeighbors' candidate list for a query planted inside that pile
// scales with local density, not with army size — ordinary battles never come close to
// this many bodies in one broad-phase cell, so bounding it here changes nothing for them,
// but it keeps a genuinely pathological pile from turning one applySeparation call into
// a near-O(pile^2) pass. MAX_SEPARATION_NEIGHBORS is well above any realistic legitimate
// local cluster (verified by the full test/balance/determinism suites staying green).
export const MAX_SEPARATION_NEIGHBORS = 40;

// The [start, take) window into a length-`n` candidate list that unit `gi` scans this
// call. Identity ([0, n)) under the cap — byte-identical to the old plain for-of. Past
// the cap it takes a fixed-size slice that starts at (gi + tick) % n: offset by gi so a
// huge pile isn't split into an "always resolved" low-_gi group and a "never resolved"
// high-_gi remainder within a single tick, and slid forward by the simulation's own tick
// counter so a pile sitting at a stable local density doesn't get stuck scanning the same
// window forever — every pair comes into some unit's window at least once every n ticks.
// state.tick is a plain deterministic counter (engine/state.js), so this stays exactly as
// reproducible as everything else in a seeded replay. Pure arithmetic, no allocation —
// safe to call once per unit on the hot path.
/** @param {number} n @param {number} gi @param {number} tick @returns {[number, number]} */
export function separationWindow(n, gi, tick) {
  if (n <= MAX_SEPARATION_NEIGHBORS) return [0, n];
  return [(gi + tick) % n, MAX_SEPARATION_NEIGHBORS];
}

/** @param {State} state @param {number} dt */
export function applySeparation(state, dt) {
  const grid = state.unitGrid;
  if (!grid) {
    // No broad-phase index (a direct unit test, not a full tick): exact original
    // all-pairs pass, so those tests stay byte-for-byte unchanged.
    const units = [...state.units.values()];
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) separatePair(units[i], units[j], dt);
    }
    return;
  }
  // Grid broad phase: for each unit, only test the handful of units in nearby
  // cells, and only the higher-indexed one of each pair so every pair resolves
  // exactly once (matching the i<j semantics above) — bounded by separationWindow
  // so a pathologically dense cell can't blow up a single tick's cost.
  for (const a of state.units.values()) {
    const near = queryNeighbors(grid, a.x, a.y, SEP_RADIUS);
    const n = near.length;
    const [start, take] = separationWindow(n, a._gi, state.tick);
    for (let k = 0; k < take; k++) {
      const b = near[(start + k) % n];
      if (b._gi > a._gi && b.hp > 0) separatePair(a, b, dt);
    }
  }
}

function separatePair(a, b, dt) {
  if (a.owner !== b.owner) return;
  const minDist = UNITS[a.type].radius + UNITS[b.type].radius;

  let dx = b.x - a.x, dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  if (dist >= minDist) return;

  if (dist < 1e-4) {
    const angle = hashAngle(a.id, b.id);
    dx = Math.cos(angle); dy = Math.sin(angle); dist = 1;
  }

  const overlap = minDist - dist;
  const nx = dx / dist, ny = dy / dist;
  const push = Math.min(overlap, PUSH_SPEED * dt) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
}

// Deterministic per-pair direction for the (rare) exactly-coincident case,
// so two units spawned on the same point don't jitter frame to frame.
function hashAngle(idA, idB) {
  return (hashStr(idA + idB) % 360) * (Math.PI / 180);
}
