/* ============================================================
   Building placement validity: kept out of a Barracks/Command Center,
   another building, a resource node, or off the map edge. Shared by
   commands.js (the authoritative check before a build order is
   accepted) and render.js (a live preview while the player is still
   choosing where to click).
   ============================================================ */

"use strict";

import { BUILDINGS } from "./entities.js";

// Matches map.js's NODE_VISUAL_RADIUS -- keeps a placed building from
// visually overlapping a deposit even though nodes aren't collision
// bodies during normal movement.
const NODE_CLEARANCE = 16;
const BUILDING_MARGIN = 6;   // a little breathing room, not just zero-overlap

export function isValidPlacement(state, buildingType, x, y) {
  const def = BUILDINGS[buildingType];
  if (!def) return false;
  const r = def.radius;
  if (x - r < 0 || x + r > state.map.width || y - r < 0 || y + r > state.map.height) return false;

  for (const b of state.buildings.values()) {
    if (Math.hypot(b.x - x, b.y - y) < r + b.radius + BUILDING_MARGIN) return false;
  }
  for (const n of state.map.nodes) {
    if (n.amount <= 0) continue;
    if (Math.hypot(n.x - x, n.y - y) < r + NODE_CLEARANCE) return false;
  }
  return true;
}
