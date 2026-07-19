/* ============================================================
   Fog of war: a coarse grid tracks which cells are currently in sight of
   an owner's unit/building (recomputed fresh every tick) and which have
   ever been seen (permanent, once set). Both sides get their own grid —
   state.fog for the player, state.fogAI for the AI — so neither is
   omniscient; the same createFog/updateFog serves both (updateFog takes
   the owner). See engine/ai.js for how the AI's grid gates its decisions.

   Deliberately scoped to units/buildings only — charted surface deposits
   (data.js) stay visible regardless, treated as known map knowledge, not
   battlefield intel. Hidden caches (map.js) are the exception: they only
   count as known once their cell has been explored (isNodeDiscovered).
   There's no "remembered snapshot" of enemy positions once they leave
   vision — they simply stop rendering (or, for the AI, stop being read).
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { sampleTerrain, sideMod } from "./map.js";

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

// Ordinary charted deposits are always known; a hidden cache (map.js) only
// exists for the player once they've scouted its cell. The permanent explored
// memory doubles as the discovery record, so a found cache stays on the map
// even after the scout moves on. Used by render/minimap/input alike so what
// shows, what the minimap dots, and what a right-click can target all agree.
export function isNodeDiscovered(fog, node) {
  return !node.hidden || isExploredAt(fog, node.x, node.y);
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
  // A world's sight modifier scales every reveal radius (see PLANET_MODIFIERS).
  // Optional-chained so the fog tests' map-less stubs read the default 1.
  const sightMult = sideMod(state, owner, "sightMult");   // per-side on an asymmetric world (updateFog is already called per owner)
  // A source standing on high ground sees farther (terrain sightMult); OPEN and
  // the map-less test stubs read 1. One sample per source per tick.
  const terr = state.map?.terrain;
  const srcMult = (x, y) => (terr ? sampleTerrain(terr, x, y).sightMult : 1);
  for (const u of state.units.values()) {
    if (u.owner === owner) reveal(fog, u.x, u.y, UNITS[u.type].sight * sightMult * srcMult(u.x, u.y));
  }
  for (const b of state.buildings.values()) {
    if (b.owner === owner) reveal(fog, b.x, b.y, BUILDINGS[b.type].sight * sightMult * srcMult(b.x, b.y));
  }
}
