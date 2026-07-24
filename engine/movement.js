// @ts-check
/* ============================================================
   Movement with local avoidance: a unit senses same-owner neighbors
   ahead of it and steers sideways around them, instead of walking
   straight through and only getting untangled after the fact by
   separation.js's reactive correction pass (still there as a safety
   net for cases avoidance alone can't resolve, like several units
   genuinely told to stand on the same point).

   Steering is lateral (perpendicular to the direction of travel), not a
   straight push-back — a neighbor sitting exactly on the travel line has
   zero radial sideways component by symmetry, so pure repulsion stalls
   an approaching unit directly behind it forever instead of routing
   around. A deterministic per-pair tie-break picks a side for that
   dead-ahead case so the choice doesn't flicker frame to frame.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { queryNeighbors } from "./grid.js";
import { sampleTerrain, sideMod } from "./map.js";
import { hashStr } from "./rng.js";

const AVOID_RANGE = 30;     // how far out a unit senses neighbors to steer around, beyond their combined radii
const AVOID_WEIGHT = 1.6;   // how strongly a sensed neighbor bends the seek direction
// Derived from the roster, not hardcoded: the old literal (10, "Breacher") went stale the moment
// a wider hull was added (the Bulk Freighter is 15), which silently under-sized the avoidance
// query — it only kept working because the grid pads each query by a full cell. Computing it
// once at module load from static UNITS data keeps it correct as the roster grows, with no
// purity issue (no randomness/clock). A larger query returns a superset of candidates that the
// exact-distance check still filters identically, so replays stay byte-identical.
export const MAX_UNIT_RADIUS = Math.max(...Object.values(UNITS).map(u => u.radius || 0));

/** @param {Unit|Building} entity @returns {number} */
function radiusOf(entity) {
  return UNITS[entity.type] ? UNITS[entity.type].radius : 9;
}

// The formation slot for an escorting unit — a point on a protective ring around the friendly
// ship it's guarding (order {type:"escort", targetId, slot, slots}). The ring expands if the
// group is large enough to crowd it, so N escorts space out evenly around the target. Returns
// null when the target is gone or dead, so the caller drops the order. Pure + deterministic:
// geometry only (no clock/RNG). The escort re-seeks this point every tick, so it trails the
// target wherever it's ordered — and a combat escort still auto-acquires threats that come near.
const ESCORT_GAP = 22;        // arc spacing between neighbouring escorts
const ESCORT_STANDOFF = 26;   // clearance from the target's hull out to the ring
/** @param {State} state @param {Unit} unit @returns {{x:number, y:number}|null} */
export function escortSlot(state, unit) {
  const o = unit.order;
  const target = state.units.get(o.targetId);
  if (!target || target.hp <= 0) return null;
  const n = Math.max(1, o.slots || 1);
  const angle = ((o.slot || 0) / n) * Math.PI * 2 - Math.PI / 2;   // start at the top, go round
  const minR = (n * ESCORT_GAP) / (2 * Math.PI);                   // ring big enough to seat the whole group
  const R = Math.max(radiusOf(target) + ESCORT_STANDOFF, minR);
  return { x: target.x + Math.cos(angle) * R, y: target.y + Math.sin(angle) * R };
}

// Advance an escorting unit one tick toward its formation slot. Returns false — and drops the
// order — when the guarded target is gone; true while it's still escorting. All three escort
// branches (combat ship, worker, support drone) did exactly this by hand, so the shared
// escortSlot→drop-or-step logic lives here once. Pure follow: never cleared on arrival, so the
// escort trails the target wherever it goes.
/** @param {State} state @param {Unit} unit @param {number} speed @param {number} dt @returns {boolean} */
export function keepEscortStation(state, unit, speed, dt) {
  const slot = escortSlot(state, unit);
  if (!slot) { unit.order = null; return false; }
  stepToward(state, unit, slot.x, slot.y, speed, dt);
  return true;
}

// Moves `unit` at most `speed * dt` toward (tx, ty). Returns true once it
// has arrived (within 1 unit), so callers can clear the order that got it
// there.
/** @param {State} state @param {Unit} unit @param {number} tx @param {number} ty @param {number} speed @param {number} dt @returns {boolean} */
export function stepToward(state, unit, tx, ty, speed, dt) {
  // Hardening: a non-finite destination (NaN/Infinity — a tampered save whose order
  // coords slipped coercion, or a future bug) would drive unit.x/unit.y to NaN below,
  // and a single NaN position poisons the separation spatial hash for every neighbour
  // it buckets with. Refuse to step toward an unreachable point: leave the unit's
  // (finite) position untouched and report arrival, so the caller clears the order as
  // if it had already been reached. Finite orders never take this branch, so valid
  // movement replays byte-identically.
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return true;
  const dx0 = tx - unit.x, dy0 = ty - unit.y;
  const distToTarget = Math.hypot(dx0, dy0);
  if (distToTarget <= 1) { unit.x = tx; unit.y = ty; return true; }

  const seekX = dx0 / distToTarget, seekY = dy0 / distToTarget;
  let dirX = seekX, dirY = seekY;

  const lateral = senseLateralAvoidance(state, unit, seekX, seekY);
  if (lateral !== 0) {
    const perpX = -seekY, perpY = seekX;   // 90° left of the seek direction
    const steerX = seekX + perpX * lateral * AVOID_WEIGHT;
    const steerY = seekY + perpY * lateral * AVOID_WEIGHT;
    const mag = Math.hypot(steerX, steerY);
    if (mag > 1e-6) { dirX = steerX / mag; dirY = steerY / mag; }
  }

  // Per-planet speed modifier (PLANET_MODIFIERS) and per-cell terrain both scale
  // the step at the one choke point every mover funnels through. Terrain is a
  // slow-down only (rough ground), never zero, so a unit always makes forward
  // progress — nothing can be trapped. Optional-chained so map-less test stubs
  // read the default 1; `allTerrain` on a def opts a unit out (forward-compat).
  const speedMult = sideMod(state, unit.owner, "speedMult");
  const def = UNITS[unit.type];
  const terrainMult = state.map?.terrain && !(def && def.allTerrain)
    ? sampleTerrain(state.map.terrain, unit.x, unit.y).speedMult : 1;
  const step = Math.min(distToTarget, speed * speedMult * terrainMult * dt);
  unit.x += dirX * step;
  unit.y += dirY * step;
  return false;
}

// Sums a sideways-steer contribution from every same-owner neighbor
// ahead of the unit and within sensing range — positive means "steer
// left of the seek direction," negative "steer right." A neighbor
// behind the unit (already passed) is ignored.
/** @param {State} state @param {Unit} unit @param {number} seekX @param {number} seekY @returns {number} */
function senseLateralAvoidance(state, unit, seekX, seekY) {
  const perpX = -seekY, perpY = seekX;
  const selfR = radiusOf(unit);
  // Broad phase: only same-owner neighbours in nearby cells can be within sense
  // range. Falls back to the full unit list when there's no grid (direct tests).
  const others = state.unitGrid
    ? queryNeighbors(state.unitGrid, unit.x, unit.y, selfR + MAX_UNIT_RADIUS + AVOID_RANGE)
    : state.units.values();
  let lateral = 0;
  for (const other of others) {
    if (other === unit || other.owner !== unit.owner || other.hp <= 0) continue;
    const dx = other.x - unit.x, dy = other.y - unit.y;
    const dist = Math.hypot(dx, dy);
    const detectRange = selfR + radiusOf(other) + AVOID_RANGE;
    if (dist <= 0 || dist >= detectRange) continue;

    const ahead = dx * seekX + dy * seekY;
    if (ahead <= 0) continue;   // don't dodge something already behind you

    let side = dx * perpX + dy * perpY;
    if (Math.abs(side) < 1e-3) side = tieBreak(unit.id, other.id);

    const weight = (detectRange - dist) / detectRange;
    lateral += (side > 0 ? -1 : 1) * weight;
  }
  return lateral;
}

// Stable per-pair left/right pick for a neighbor sitting exactly on the
// travel line, so the dodge direction doesn't flicker tick to tick.
/** @param {string} idA @param {string} idB @returns {number} */
function tieBreak(idA, idB) {
  return hashStr(idA + idB) % 2 === 0 ? 1 : -1;
}
