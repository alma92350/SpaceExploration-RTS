import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap, sampleTerrain, TERRAIN } from "../engine/map.js";
import { stepToward } from "../engine/movement.js";
import { canPlaceBuilding } from "../engine/colliders.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A world that carries terrain (pyralis has a central high-ground mesa) and one
// that doesn't (ferros, all-open).
function pyralis(opts = {}) { return generateMap("pyralis", () => 0.5, opts); }
function ferros(opts = {}) { return generateMap("ferros", () => 0.5, opts); }

test("the original worlds are all-open; a terrain world has non-open cells", () => {
  const f = ferros().terrain;
  assert.ok(f.type.every(c => c === 0), "ferros carries no terrain — every cell is open");
  const p = pyralis().terrain;
  assert.ok(p.type.some(c => c !== 0), "pyralis stamps a terrain feature");
});

test("sampleTerrain returns OPEN out of bounds and for a missing grid", () => {
  const p = pyralis().terrain;
  assert.equal(sampleTerrain(p, -50, -50).name, "open");
  assert.equal(sampleTerrain(p, 1e9, 1e9).name, "open");
  assert.equal(sampleTerrain(null, 100, 100), TERRAIN[0]);
});

test("pyralis' central mesa is high ground", () => {
  const map = pyralis();
  const mid = sampleTerrain(map.terrain, map.width * 0.5, map.height * 0.5);
  assert.equal(mid.name, "high", "the middle of pyralis is a high-ground mesa");
  assert.ok(mid.sightMult > 1 && mid.combatMult > 1, "high ground sees and hits harder");
});

test("terrain scales with map size and mirrors across the centreline", () => {
  const small = pyralis({ sizeMult: 1 }).terrain;
  const big = pyralis({ sizeMult: 4 }).terrain;
  assert.ok(big.cols > small.cols && big.rows > small.rows, "the grid scales with the map");
  // forge's rough fields are mirrored; assert symmetry about the vertical centre.
  const map = generateMap("forge", () => 0.5);
  for (const [fx, fy] of [[0.4, 0.32], [0.4, 0.68]]) {
    const a = sampleTerrain(map.terrain, map.width * fx, map.height * fy).name;
    const b = sampleTerrain(map.terrain, map.width * (1 - fx), map.height * fy).name;
    assert.equal(a, b, "a mirrored feature reads the same on both sides");
  }
});

test("terrain is deterministic and consumes no rng: two same-seed maps match, and terrain doesn't perturb nodes", () => {
  const a = generateMap("pyralis", mulberry32(9));
  const b = generateMap("pyralis", mulberry32(9));
  assert.deepEqual([...a.terrain.type], [...b.terrain.type], "same seed -> identical terrain");
  assert.deepEqual(a.nodes, b.nodes, "and identical nodes (terrain draws no rng)");
});

test("rough ground slows a unit crossing it versus open ground", () => {
  const map = generateMap("forge", () => 0.5);
  // A rough cell (forge stamps rough at ~0.4,0.32) and a definitely-open cell.
  const rough = sampleTerrain(map.terrain, map.width * 0.4, map.height * 0.32);
  assert.equal(rough.name, "rough", "fixture sanity: that spot is rough");

  const advance = (fx, fy) => {
    const unit = { type: "skiff", x: map.width * fx, y: map.height * fy };
    const state = { map, units: new Map() };
    const startX = unit.x;
    stepToward(state, unit, unit.x + 1000, unit.y, 90, 0.1);   // push hard along +x
    return unit.x - startX;
  };
  const onRough = advance(0.4, 0.32);
  const onOpen = advance(0.4, 0.5);   // centre column of forge is open
  assert.ok(onRough < onOpen, `rough advance ${onRough.toFixed(2)} should be less than open ${onOpen.toFixed(2)}`);
});

test("a building can't be placed on rough terrain, but can on open ground", () => {
  const map = generateMap("forge", () => 0.5);
  const state = { map, buildings: new Map() };
  const roughX = map.width * 0.4, roughY = map.height * 0.32;
  assert.equal(sampleTerrain(map.terrain, roughX, roughY).name, "rough");
  assert.equal(canPlaceBuilding(state, "barracks", roughX, roughY), false, "no building on rough ground");
  // Open ground near the same area (centre column) accepts it.
  assert.equal(canPlaceBuilding(state, "barracks", map.width * 0.5, map.height * 0.5 + 200), true);
});
