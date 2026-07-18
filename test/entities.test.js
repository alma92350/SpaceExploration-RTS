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
  assert.equal(UNITS.bastion.role, "combat");
  assert.equal(BUILDINGS.command.isCommandCenter, true);
  assert.ok(BUILDINGS.barracks.produces.includes("skiff"));
  assert.ok(BUILDINGS.barracks.produces.includes("bastion"));
});

test("Bastion is the deliberate Skiff counter: bonus damage vs skiff, but slower and costlier", () => {
  assert.equal(UNITS.bastion.bonusVs.skiff, 14);
  assert.ok(UNITS.bastion.speed < UNITS.skiff.speed, "Bastion should be slower, not a strict upgrade");
  assert.ok(UNITS.bastion.cost.ore > UNITS.skiff.cost.ore, "Bastion should cost more, not a strict upgrade");
  assert.ok(UNITS.bastion.hp > UNITS.skiff.hp);
});

test("Lancer is the deliberate Bastion counter: bonus damage vs bastion, but squishier and not a strict upgrade", () => {
  assert.equal(UNITS.lancer.bonusVs.bastion, 20);
  assert.ok(UNITS.lancer.hp < UNITS.bastion.hp, "Lancer should be squishier than the Bastion it counters");
  assert.ok(UNITS.lancer.range > UNITS.bastion.range, "Lancer's long range is its edge against Bastion's short melee range");
});

test("the rock-paper-scissors triangle closes: Skiff beats Lancer, Bastion beats Skiff, Lancer beats Bastion", () => {
  assert.equal(UNITS.skiff.bonusVs.lancer, 10);
  assert.equal(UNITS.bastion.bonusVs.skiff, 14);
  assert.equal(UNITS.lancer.bonusVs.bastion, 20);
  assert.equal(UNITS.lancer.role, "combat");
  assert.ok(BUILDINGS.barracks.produces.includes("lancer"));
});

test("the Command Center is buildable but steep: the priciest, slowest structure on the roster", () => {
  assert.equal(BUILDINGS.command.cost.ore, 400);
  assert.equal(BUILDINGS.command.buildTime, 30);
  assert.ok(BUILDINGS.command.buildTime > BUILDINGS.barracks.buildTime, "an expansion should take longer than a Barracks");
  assert.ok(BUILDINGS.command.cost.ore > BUILDINGS.refinery.cost.ore, "an expansion should out-price every other building");
});

test("every unit and building carries a sight radius for fog of war", () => {
  for (const def of Object.values(UNITS)) assert.ok(def.sight > 0, `${def.id} needs a sight radius`);
  for (const def of Object.values(BUILDINGS)) assert.ok(def.sight > 0, `${def.id} needs a sight radius`);
});

test("the Sentinel Turret is a crystal sink with real combat stats", () => {
  const turret = BUILDINGS.turret;
  assert.ok(turret.cost.crystals > 0, "the turret should cost crystals — it's the first repeatable crystal sink");
  assert.ok(turret.attack > 0, "a static defense with no attack is pointless");
  assert.equal(turret.range, turret.aggroRange, "a turret can't chase, so acquiring beyond its own range is useless");
  assert.ok(turret.sight >= turret.range, "sight must cover its own range or it fires blind");
});

test("the Breacher is a radioactives sink, produced by the Barracks", () => {
  assert.ok(UNITS.breacher.cost.radioactives > 0, "the Breacher should cost radioactives — the first repeatable radioactive sink");
  assert.ok(BUILDINGS.barracks.produces.includes("breacher"));
  assert.equal(UNITS.breacher.role, "combat");
});

test("the Breacher sits outside the triangle and outranges the turret", () => {
  assert.ok(!UNITS.breacher.bonusVs, "the Breacher must carry no bonusVs — it's outside the rock-paper-scissors triangle");
  for (const type of ["skiff", "bastion", "lancer"]) {
    assert.ok(!UNITS[type].bonusVs.breacher, `${type} must not counter the Breacher, or it would be inside the triangle`);
  }
  assert.ok(UNITS.breacher.range > BUILDINGS.turret.range, "the Breacher's whole edge is out-ranging the turret's acquisition");
  assert.ok(UNITS.breacher.bonusVsBuildings > 0, "its identity is the structure bonus, not anti-unit power");

  const dps = def => def.attack / def.cooldown;
  const combatUnits = Object.values(UNITS).filter(u => u.role === "combat");
  const worst = Math.min(...combatUnits.map(dps));
  assert.equal(dps(UNITS.breacher), worst, "the Breacher should deal the worst raw DPS of any combat unit");
});
