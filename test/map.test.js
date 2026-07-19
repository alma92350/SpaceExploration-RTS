import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap, MAP_WIDTH, MAP_HEIGHT, PLANET_MODIFIERS } from "../engine/map.js";
import { PLANET_ARCHETYPE } from "../engine/aiArchetypes.js";
import { PLANETS } from "../data.js";

// Tiny deterministic PRNG so two generateMap runs can share an identical
// rng sequence (() => 0.5 can't distinguish "same seed" from "constant").
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("generateMap only scatters surface nodes for commodities the planet actually deposits", () => {
  const map = generateMap("ferros", () => 0.5);
  const coms = new Set(map.nodes.filter(n => !n.hidden).map(n => n.com));   // hidden caches can add others
  assert.deepEqual([...coms].sort(), ["crystals", "ore", "radioactives"]);
});

test("generateMap mirrors clusters so both bases start with access to every deposit", () => {
  const map = generateMap("ferros", () => 0.5);
  const oreNodes = map.nodes.filter(n => n.com === "ore");
  assert.equal(oreNodes.length % 2, 0);
  const nearPlayer = oreNodes.filter(n => n.x < MAP_WIDTH / 2).length;
  const nearAi = oreNodes.filter(n => n.x >= MAP_WIDTH / 2).length;
  assert.equal(nearPlayer, nearAi);
});

test("generateMap places the two bases inside the map bounds", () => {
  const map = generateMap("ferros");
  for (const base of Object.values(map.bases)) {
    assert.ok(base.x >= 0 && base.x <= MAP_WIDTH);
    assert.ok(base.y >= 0 && base.y <= MAP_HEIGHT);
  }
});

test("generateMap throws on an unknown planet id", () => {
  assert.throws(() => generateMap("not-a-real-planet"));
});

test("no two nodes overlap, even across different commodity types", () => {
  // rng() => 0.5 is the exact seed that used to land an ore cluster and a
  // crystals cluster on the identical point (each commodity picks its own
  // y-band independently, with no coordination between them).
  for (const planetId of ["ferros", "korrath", "vesper", "glacius", "helix"]) {
    const map = generateMap(planetId, () => 0.5);
    for (let i = 0; i < map.nodes.length; i++) {
      for (let j = i + 1; j < map.nodes.length; j++) {
        const a = map.nodes[i], b = map.nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(dist >= 32 - 1e-6, `${planetId}: ${a.com} node and ${b.com} node are only ${dist.toFixed(1)} apart`);
      }
    }
  }
});

test("overlap resolution keeps every node inside the map bounds", () => {
  const map = generateMap("ferros", () => 0.5);
  for (const n of map.nodes) {
    assert.ok(n.x >= 0 && n.x <= MAP_WIDTH, `node x=${n.x} out of bounds`);
    assert.ok(n.y >= 0 && n.y <= MAP_HEIGHT, `node y=${n.y} out of bounds`);
  }
});

test("a world that deposits no ore still gets a mirrored ore cluster near each base", () => {
  const map = generateMap("glacius", () => 0.5);   // glacius deposits only ice and gas
  const oreNodes = map.nodes.filter(n => n.com === "ore");
  assert.ok(oreNodes.length > 0, "the guarantee should have inserted ore");
  assert.equal(oreNodes.length % 2, 0, "guaranteed ore should come as mirrored pairs");
  const left = oreNodes.filter(n => n.x < MAP_WIDTH / 2).length;
  const right = oreNodes.filter(n => n.x >= MAP_WIDTH / 2).length;
  assert.equal(left, right);
  for (const base of Object.values(map.bases)) {
    const near = oreNodes.some(n => Math.hypot(n.x - base.x, n.y - base.y) <= 500);
    assert.ok(near, "each base should have an ore node within reach");
  }
});

test("every charted world yields ore within reach of both bases", () => {
  for (const planet of PLANETS) {
    const map = generateMap(planet.id, () => 0.5);
    for (const base of Object.values(map.bases)) {
      const near = map.nodes.some(n => n.com === "ore" &&
        Math.hypot(n.x - base.x, n.y - base.y) <= 500);
      assert.ok(near, `${planet.id}: no ore within 500 of the base at (${base.x}, ${base.y})`);
    }
  }
});

test("the ore guarantee never fires on an ore-bearing world: ferros keeps its deposit-table node count", () => {
  const map = generateMap("ferros", () => 0.5);
  const oreNodes = map.nodes.filter(n => n.com === "ore" && !n.hidden);   // surface ore only; caches are separate
  assert.equal(oreNodes.length, Math.round(2.0 * 1.5) * 2);   // ferros' ore yieldMult drives exactly 3 mirrored clusters
});

test("generateMap is deterministic: the same planet and rng seed reproduce the same nodes", () => {
  const a = generateMap("glacius", lcg(42));
  const b = generateMap("glacius", lcg(42));
  assert.deepEqual(a.nodes, b.nodes);
});

test("generateMap attaches the planet's modifiers (empty for the unmodified worlds)", () => {
  assert.deepEqual(generateMap("ferros", () => 0.5).modifiers, {}, "ferros carries no modifiers");
  assert.equal(generateMap("glacius", () => 0.5).modifiers.speedMult, 0.9, "glacius slows every unit");
});

test("helix's dense belt adds one extra crystal cluster per side, on top of its deposit table", () => {
  const map = generateMap("helix", () => 0.5);
  const crystals = map.nodes.filter(n => n.com === "crystals" && !n.hidden);   // surface crystals only
  const left = crystals.filter(n => n.x < MAP_WIDTH / 2).length;
  const right = crystals.filter(n => n.x >= MAP_WIDTH / 2).length;
  // helix crystals yieldMult 1.4 -> round(1.4 * 1.5) = 2 deposit clusters per side, + 1 belt cluster.
  assert.equal(left, Math.round(1.4 * 1.5) + 1);
  assert.equal(right, Math.round(1.4 * 1.5) + 1);
});

test("oort's rich frontier makes its deposits hold 30% more", () => {
  const map = generateMap("oort", () => 0.5);
  const oreNodes = map.nodes.filter(n => n.com === "ore" && !n.hidden);   // surface ore; hidden caches size differently
  assert.ok(oreNodes.length > 0);
  // oort deposits ore at 1.2, so the ore guarantee never fires here — every
  // surface ore node is a deposit-table node scaled by the 1.3 nodeAmountMult.
  for (const n of oreNodes) {
    assert.equal(n.max, Math.round(600 * 1.2 * 1.3));
  }
});

test("every world seeds hidden caches out in the field, away from both bases", () => {
  for (const id of ["ferros", "korrath", "glacius"]) {
    const map = generateMap(id, () => 0.5);
    const caches = map.nodes.filter(n => n.hidden);
    assert.ok(caches.length >= 6, `${id}: should scatter several discoverable caches`);
    for (const c of caches) {
      assert.ok(c.amount > 0 && c.max > 0, "a cache holds a real amount");
      assert.ok(["ore", "crystals", "radioactives"].includes(c.com), "caches hold spendable commodities");
      for (const base of Object.values(map.bases)) {
        assert.ok(Math.hypot(c.x - base.x, c.y - base.y) > 300, `${id}: a cache must sit out where you have to explore for it`);
      }
    }
  }
});

test("hidden caches can hold a commodity the planet's surface lacks — exploration unlocks it", () => {
  // Korrath deposits no crystals on the surface (so no turrets/plating without them).
  const map = generateMap("korrath", () => 0.5);
  const surfaceCrystals = map.nodes.filter(n => n.com === "crystals" && !n.hidden);
  const cacheCrystals = map.nodes.filter(n => n.com === "crystals" && n.hidden);
  assert.equal(surfaceCrystals.length, 0, "korrath's surface truly has no crystals");
  assert.ok(cacheCrystals.length > 0, "but a scouted cache can still yield them");
});

test("every modified world is a real planet with a nonempty label, and has an archetype", () => {
  for (const [id, mod] of Object.entries(PLANET_MODIFIERS)) {
    assert.ok(PLANETS.some(p => p.id === id), `${id} should be a real planet`);
    assert.ok(id in PLANET_ARCHETYPE, `${id} should be in the picker roster`);
    assert.ok(mod.label && mod.label.length > 0, `${id} should carry a human-readable label`);
  }
});
