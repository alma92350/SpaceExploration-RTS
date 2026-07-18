/* ============================================================
   Fog of war for the player's view: a coarse grid tracks which cells
   are currently in sight of a player unit/building (recomputed fresh
   every tick) and which have ever been seen (permanent, once set).

   Deliberately scoped to units/buildings only — resource nodes stay
   visible regardless (the charted deposits from data.js are treated as
   known map knowledge, not battlefield intel), and there's no
   "remembered snapshot" of enemy positions once they leave vision, they
   simply stop rendering. The AI plays with full knowledge of the map
   internally (it always has); this only ever gates what the player sees
   and can target.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";

export const FOG_CELL_SIZE = 40;

export function createFog(map) {
  const cols = Math.ceil(map.width / FOG_CELL_SIZE);
  const rows = Math.ceil(map.height / FOG_CELL_SIZE);
  return { cols, rows, explored: new Uint8Array(cols * rows), visible: new Uint8Array(cols * rows) };
}

function cellOf(fog, wx, wy) {
  return { cx: Math.floor(wx / FOG_CELL_SIZE), cy: Math.floor(wy / FOG_CELL_SIZE) };
}

function inBounds(fog, cx, cy) {
  return cx >= 0 && cy >= 0 && cx < fog.cols && cy < fog.rows;
}

export function isVisibleAt(fog, wx, wy) {
  const { cx, cy } = cellOf(fog, wx, wy);
  return inBounds(fog, cx, cy) && fog.visible[cy * fog.cols + cx] === 1;
}

export function isExploredAt(fog, wx, wy) {
  const { cx, cy } = cellOf(fog, wx, wy);
  return inBounds(fog, cx, cy) && fog.explored[cy * fog.cols + cx] === 1;
}

function reveal(fog, x, y, sight) {
  const { cx, cy } = cellOf(fog, x, y);
  const reach = Math.ceil(sight / FOG_CELL_SIZE);
  for (let gy = Math.max(0, cy - reach); gy <= Math.min(fog.rows - 1, cy + reach); gy++) {
    for (let gx = Math.max(0, cx - reach); gx <= Math.min(fog.cols - 1, cx + reach); gx++) {
      const cellCx = gx * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
      const cellCy = gy * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
      if (Math.hypot(cellCx - x, cellCy - y) > sight) continue;
      const idx = gy * fog.cols + gx;
      fog.visible[idx] = 1;
      fog.explored[idx] = 1;
    }
  }
}

// Recomputes `visible` from scratch each call (cheap at this grid
// resolution) and folds newly-seen cells permanently into `explored`.
export function updateFog(state, fog, owner) {
  fog.visible.fill(0);
  for (const u of state.units.values()) {
    if (u.owner === owner) reveal(fog, u.x, u.y, UNITS[u.type].sight);
  }
  for (const b of state.buildings.values()) {
    if (b.owner === owner) reveal(fog, b.x, b.y, BUILDINGS[b.type].sight);
  }
}
