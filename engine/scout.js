/* ============================================================
   Autonomous scout mode for the Ranger (order type "scout"): range the
   map on its own, always heading for the nearest unexplored ground, so
   one click sends a scout off to chart the map instead of the player
   hand-walking it waypoint by waypoint.

   It heads for the nearest never-explored cell (its own owner's fog). Its
   long sight reveals that ground as it approaches, so the target flips to
   explored and it re-picks the next-nearest dark cell — the effect is a
   frontier that expands outward from home until the map is charted. Once
   nothing is left unexplored it patrols a fixed circuit of the map's
   quadrants, keeping vision fresh rather than freezing in place.

   Persistent: the "scout" order is never cleared by arrival (there's no
   single destination), so it keeps exploring until the player re-orders the
   unit (a move/attack/stop replaces it). Deterministic throughout — the
   target comes from a row-major fog scan, no rng — so it's safe in the sim.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS } from "./entities.js";
import { nearestUnexploredPoint, isExploredAt } from "./fog.js";

const REACH = 6;   // close enough to a scout waypoint to count as arrived and re-pick

// A coarse patrol circuit for when the whole map is already charted: the four
// quadrant centres, walked in a loop so the scout keeps sweeping for fresh
// intel (enemy movements) instead of parking. Fractions of the map dims.
const PATROL = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]];

export function updateScoutMode(state, unit, dt) {
  const def = UNITS[unit.type];
  const fog = unit.owner === "player" ? state.fog : state.fogAI;
  const order = unit.order;

  // Re-pick a target when we have none, we've reached it, or our own sight has
  // since revealed it (so we always chase ground that's still dark).
  const need = order.tx == null
    || Math.hypot(order.tx - unit.x, order.ty - unit.y) <= REACH
    || (fog && order.explore && isExploredAt(fog, order.tx, order.ty));
  if (need) {
    const spot = fog ? nearestUnexploredPoint(fog, unit.x, unit.y) : null;
    if (spot) {
      order.tx = spot.x; order.ty = spot.y; order.explore = true;
    } else {
      // Nothing left to discover — walk a patrol circuit to keep vision fresh.
      order.patrol = ((order.patrol ?? -1) + 1) % PATROL.length;
      const [fx, fy] = PATROL[order.patrol];
      order.tx = (state.map?.width || 0) * fx;
      order.ty = (state.map?.height || 0) * fy;
      order.explore = false;
    }
  }
  stepToward(state, unit, order.tx, order.ty, def.speed, dt);
}
