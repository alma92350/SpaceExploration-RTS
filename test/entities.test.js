import { test } from "node:test";
import assert from "node:assert/strict";
import { canAfford, payCost, prereqsMet, committedDoctrine, isDropOff, UNITS, BUILDINGS, UPGRADES } from "../engine/entities.js";

// Minimal state stub for prereqsMet: it only reads state.buildings and
// state.players[owner].upgrades.
function stubState(buildings = [], upgrades = {}) {
  return {
    buildings: new Map(buildings.map((b, i) => [b.id || `b${i}`, { id: b.id || `b${i}`, ...b }])),
    players: { player: { upgrades } },
  };
}

test("the Tier-2 units are gated behind the Foundry; the Foundry behind the Barracks", () => {
  assert.deepEqual(UNITS.lancer.requires, ["foundry"]);
  assert.deepEqual(UNITS.breacher.requires, ["foundry"]);
  assert.deepEqual(BUILDINGS.foundry.requires, ["barracks"]);
  assert.equal(UNITS.skiff.requires, undefined, "Skiff is the ungated fallback");
  assert.equal(UNITS.bastion.requires, undefined, "Bastion is ungated");
  assert.deepEqual(Object.keys(BUILDINGS.foundry.cost), ["ore"], "Foundry is ore-only so Tier-2 stays reachable everywhere");
});

test("upgrades form two mutually-exclusive doctrines of two tiers each", () => {
  assert.equal(UPGRADES.overchargedWeapons.doctrine, "assault");
  assert.equal(UPGRADES.overchargedCore.doctrine, "assault");
  assert.equal(UPGRADES.reinforcedPlating.doctrine, "bulwark");
  assert.equal(UPGRADES.reinforcedBulwark.doctrine, "bulwark");
  assert.equal(UPGRADES.overchargedWeapons.tier, 1);
  assert.equal(UPGRADES.overchargedCore.tier, 2);
  assert.deepEqual(UPGRADES.overchargedCore.requires, ["overchargedWeapons"], "T2 requires T1");
  assert.deepEqual(UPGRADES.reinforcedBulwark.requires, ["reinforcedPlating"]);
});

test("committedDoctrine reports the chosen path, and is null before any research", () => {
  const s = { players: { player: { upgrades: {} } } };
  assert.equal(committedDoctrine(s, "player"), null, "nothing researched -> no doctrine");
  s.players.player.upgrades.reinforcedPlating = true;
  assert.equal(committedDoctrine(s, "player"), "bulwark", "a Bulwark upgrade commits the Bulwark doctrine");
});

test("the tech tree extends past the Foundry: Arsenal (needs Foundry) -> Dreadnought", () => {
  assert.deepEqual(BUILDINGS.arsenal.requires, ["foundry"], "Arsenal is gated behind the Foundry");
  assert.deepEqual(UNITS.dreadnought.requires, ["arsenal"], "the Dreadnought is gated behind the Arsenal");
  assert.deepEqual(Object.keys(BUILDINGS.arsenal.cost), ["ore"], "Arsenal is ore-only so the path stays reachable everywhere");
  assert.ok(!UNITS.dreadnought.bonusVs, "the Dreadnought sits OUTSIDE the rock-paper-scissors triangle");
  assert.ok(BUILDINGS.barracks.produces.includes("dreadnought"), "the Barracks trains it once unlocked");
});

test("prereqsMet: no requires is always met; a building token needs a COMPLETED building", () => {
  assert.equal(prereqsMet(stubState(), "player", UNITS.skiff), true, "no requires -> available");
  // Lancer needs a foundry.
  assert.equal(prereqsMet(stubState([]), "player", UNITS.lancer), false, "no foundry -> locked");
  assert.equal(prereqsMet(stubState([{ owner: "player", type: "foundry", constructing: true }]), "player", UNITS.lancer),
    false, "a still-constructing foundry doesn't unlock it");
  assert.equal(prereqsMet(stubState([{ owner: "player", type: "foundry", constructing: false }]), "player", UNITS.lancer),
    true, "a completed foundry unlocks it");
  assert.equal(prereqsMet(stubState([{ owner: "ai", type: "foundry", constructing: false }]), "player", UNITS.lancer),
    false, "the enemy's foundry doesn't unlock yours");
});

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

test("resource drop-offs are the Command Center and the industrial buildings that proxy it", () => {
  // The CC and the industrial line (Refinery, Foundry, Arsenal) all bank hauls,
  // so a forward industrial building shortens a distant mining run without a
  // whole second Command Center.
  assert.equal(isDropOff("command"), true, "the CC is always a drop-off");
  assert.equal(isDropOff("refinery"), true);
  assert.equal(isDropOff("foundry"), true);
  assert.equal(isDropOff("arsenal"), true);
  // Troop, defense, and housing buildings are not collection points.
  assert.equal(isDropOff("barracks"), false, "the Barracks trains troops, it doesn't collect");
  assert.equal(isDropOff("turret"), false);
  assert.equal(isDropOff("habitat"), false);
  assert.equal(isDropOff("not-a-building"), false, "an unknown type is never a drop-off");
  // The flag is what the routing reads — keep def and predicate in sync.
  for (const t of ["refinery", "foundry", "arsenal"]) assert.equal(BUILDINGS[t].dropOff, true, `${t} carries the dropOff flag`);
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

test("a Worker can defend itself, but only weakly and without leaving its job behind", () => {
  assert.ok(UNITS.worker.attack > 0, "workers can fight back when ordered to");
  assert.equal(UNITS.worker.role, "worker", "it stays a worker — it still gathers and builds, and never auto-acquires");
  assert.ok(!("aggroRange" in UNITS.worker), "no aggroRange: a worker never picks a fight on its own");
  const dps = def => def.attack / def.cooldown;
  for (const type of ["skiff", "bastion", "lancer", "breacher"]) {
    assert.ok(dps(UNITS.worker) < dps(UNITS[type]), `a worker should out-damage no combat unit (${type})`);
  }
});

test("every unit carries a supply cost, and the Command Center and Habitat are the supply grantors", () => {
  for (const def of Object.values(UNITS)) assert.ok(def.supplyCost >= 1, `${def.id} needs a supply cost`);
  assert.equal(BUILDINGS.command.supplyGrants, 10, "the seeded CC houses the starting workers with room to grow");
  assert.equal(BUILDINGS.habitat.supplyGrants, 8);
  assert.ok(!BUILDINGS.habitat.produces, "the Habitat has no `produces` — keeps it out of the rally UI/render");
});
