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
import { sampleTerrain } from "./map.js";

const AVOID_RANGE = 30;     // how far out a unit senses neighbors to steer around, beyond their combined radii
const AVOID_WEIGHT = 1.6;   // how strongly a sensed neighbor bends the seek direction
const MAX_UNIT_RADIUS = 10; // largest unit radius (Breacher) — the widest a neighbor's own body reaches

function radiusOf(entity) {
  return UNITS[entity.type] ? UNITS[entity.type].radius : 9;
}

// Moves `unit` at most `speed * dt` toward (tx, ty). Returns true once it
// has arrived (within 1 unit), so callers can clear the order that got it
// there.
export function stepToward(state, unit, tx, ty, speed, dt) {
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
  const speedMult = state.map?.modifiers?.speedMult ?? 1;
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
function tieBreak(idA, idB) {
  let h = 7;
  for (const c of idA + idB) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2 === 0 ? 1 : -1;
}
