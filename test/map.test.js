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
