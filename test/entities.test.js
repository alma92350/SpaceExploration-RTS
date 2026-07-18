import { test } from "node:test";
import assert from "node:assert/strict";
import { canAfford, payCost, UNITS, BUILDINGS } from "../engine/entities.js";

test("canAfford is true only when every cost commodity is covered", () => {
  assert.equal(canAfford({ ore: 50 }, { ore: 50 }), true);
  assert.equal(canAfford({ ore: 49 }, { ore: 50 }), false);
  assert.equal(canAfford({}, {}), true);
});

test("payCost deducts every listed commodity and leaves others untouched", () => {
  const res = { ore: 200, crystals: 10 };
  payCost(res, { ore: 150 });
  assert.equal(res.ore, 50);
  assert.equal(res.crystals, 10);
});

test("unit and building defs carry the fields the sim depends on", () => {
  assert.equal(UNITS.worker.role, "worker");
  assert.equal(UNITS.skiff.role, "combat");
  assert.equal(BUILDINGS.command.isCommandCenter, true);
  assert.ok(BUILDINGS.barracks.produces.includes("skiff"));
});
