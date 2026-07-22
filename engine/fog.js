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

// World point at the centre of the nearest never-explored cell to (fromX, fromY),
// or null when the whole grid has been explored. A row-major scan with a strict
// `<` keeps the pick deterministic (first cell wins a distance tie), so it's safe
// to call from the sim. Shared by the Ranger's scout mode (heads for the nearest
// dark ground to reveal it) and the AI's hunt for a hidden Command Center (sweeps
// unexplored ground when it can see no enemy). Cheap enough at this grid
// resolution to call on demand, and only ever when a new target is needed.
export function nearestUnexploredPoint(fog, fromX, fromY) {
  let best = null, bestD = Infinity;
  for (let cy = 0; cy < fog.rows; cy++) {
    for (let cx = 0; cx < fog.cols; cx++) {
      if (fog.explored[cy * fog.cols + cx]) continue;
      const wx = cx * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
      const wy = cy * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
      const d = (wx - fromX) * (wx - fromX) + (wy - fromY) * (wy - fromY);
      if (d < bestD) { bestD = d; best = { x: wx, y: wy }; }
    }
  }
  return best;
}

function reveal(fog, x, y, sight) {
  const { cx, cy } = cellOf(fog, x, y);
  const reach = Math.ceil(sight / FOG_CELL_SIZE);
  const sightSq = sight * sight;   // compare squared distances — no per-cell sqrt (Math.hypot)
  const gyMax = Math.min(fog.rows - 1, cy + reach), gxMax = Math.min(fog.cols - 1, cx + reach);
  for (let gy = Math.max(0, cy - reach); gy <= gyMax; gy++) {
    const row = gy * fog.cols;                                // hoisted out of the inner loop
    const dy = gy * FOG_CELL_SIZE + FOG_CELL_SIZE / 2 - y;
    for (let gx = Math.max(0, cx - reach); gx <= gxMax; gx++) {
      const dx = gx * FOG_CELL_SIZE + FOG_CELL_SIZE / 2 - x;
      if (dx * dx + dy * dy > sightSq) continue;
      const idx = row + gx;
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
