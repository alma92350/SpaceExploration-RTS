import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap, MAP_WIDTH, MAP_HEIGHT } from "../engine/map.js";

test("generateMap only scatters nodes for commodities the planet actually deposits", () => {
  const map = generateMap("ferros", () => 0.5);
  const coms = new Set(map.nodes.map(n => n.com));
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
  for (const planetId of ["ferros", "korrath", "vesper"]) {
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
