// @ts-check
/* ============================================================
   Shared building-placement validation. Pure queries over state —
   never mutates. issueBuild consults canPlaceBuilding to reject bad
   placements at the source (player clicks and AI alike), and the AI
   uses findPlacement to slide its preferred build spots to the
   nearest valid ground. Tier 3's build-ghost UI should import
   canPlaceBuilding for ghost validity too — this module is the one
   source of truth for "can a footprint go here".
   Deliberately ignores units: they move, and separation.js already
   untangles anything standing where a building lands (existing
   behavior — buildings have always been droppable onto workers).
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS } from "./entities.js";
import { NODE_RADIUS, sampleTerrain } from "./map.js";

const PLACEMENT_GAP = 8;
const RING_STEP = 24;
const RING_SPOTS = 12;
const MAX_SEARCH_RADIUS = 200;

/** @param {State} state @param {string} buildingType @param {number} x @param {number} y @returns {boolean} */
export function canPlaceBuilding(state, buildingType, x, y) {
  const def = BUILDINGS[buildingType];
  if (!def) return false;
  const r = def.radius;
  const map = state.map;
  if (x - r < 0 || y - r < 0 || x + r > map.width || y + r > map.height) return false;
  for (const b of state.buildings.values()) {
    if (Math.hypot(b.x - x, b.y - y) < b.radius + r + PLACEMENT_GAP) return false;
  }
  for (const n of map.nodes) {
    if (n.amount <= 0) continue;   // depleted nodes never refill and stop rendering — dead ground is buildable
    if (Math.hypot(n.x - x, n.y - y) < NODE_RADIUS + r + PLACEMENT_GAP) return false;
  }
  // No building on unbuildable terrain (rough ground). Sample the footprint's
  // centre and corners so a building can't straddle onto it. OPEN / terrain-less
  // worlds pass every point. findPlacement slides off bad terrain for free.
  if (map.terrain) {
    const pts = [[x, y], [x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]];
    for (const [px, py] of pts) if (!sampleTerrain(map.terrain, px, py).buildable) return false;
  }
  return true;
}

// Deterministic outward ring search: the requested spot if valid, else the
// first valid candidate scanning rings of RING_STEP at RING_SPOTS fixed
// angles, else null. No rng — same state in, same spot out.
/** @param {State} state @param {string} buildingType @param {number} x @param {number} y @param {number} [maxRadius] @returns {{x:number,y:number}|null} */
export function findPlacement(state, buildingType, x, y, maxRadius = MAX_SEARCH_RADIUS) {
  if (canPlaceBuilding(state, buildingType, x, y)) return { x, y };
  for (let radius = RING_STEP; radius <= maxRadius; radius += RING_STEP) {
    for (let i = 0; i < RING_SPOTS; i++) {
      const a = (i / RING_SPOTS) * Math.PI * 2;
      const px = x + Math.cos(a) * radius, py = y + Math.sin(a) * radius;
      if (canPlaceBuilding(state, buildingType, px, py)) return { x: px, y: py };
    }
  }
  return null;
}

// The collision radius of ANY entity. Three private copies of this used to live in movement.js,
// formation.js and bomb.js, and bomb.js's comment asserted they were "the same" — they were not.
// Only bomb.js's handled a building, by reading the instance's own `radius` (engine/state.js stamps
// it at construction from BUILDINGS); the other two returned the magic constant 9 for any building,
// while movement.js's `// @ts-check`ed JSDoc advertised `@param {Unit|Building}`. So the type layer
// told callers a Building was supported on a path that silently under-sized it — the exact class of
// bug MAX_UNIT_RADIUS (engine/movement.js) exists to prevent, and which no determinism test can see
// because it is wrong-but-stable on every seed.
// Resolve by TYPE first rather than by `kind`: formation.js's callers are frequently unit-shaped
// literals that carry no `kind` field at all (see test/formation.test.js's fakeUnit), and keying on
// kind alone silently returned 0 for them.
/** @param {Unit|Building} e @returns {number} */
export function radiusOf(e) {
  if (e.kind !== "building" && UNITS[e.type]) return UNITS[e.type].radius;
  // `radius` is a Building-only instance field (state.js stamps it at construction); the cast is
  // the narrowing TypeScript can't do here, since `kind` is typed as a plain string.
  const b = /** @type {{radius?: number, type: string}} */ (e);
  return b.radius || BUILDINGS[b.type]?.radius || 0;
}
