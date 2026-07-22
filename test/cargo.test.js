import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, jumpCapital, cargoManifest, freightCapacity,
         loadFreighter, unloadFreighter, freightUsed, freightRoom } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";
import { queueProduction } from "../engine/production.js";
import { BUILDINGS } from "../engine/entities.js";

// A galaxy with a deployed base + a Spaceport, fuelled and ready to jump. `cargoShips` (unit
// types) are staged on the pad — the cargo ships whose combined hold sets the jump's freight.
function readyToJump(seed = 20, cargoShips = []) {
  const g = createGalaxy({ seed });
  const from = activeState(g);
  for (const u of [...from.units.values()]) if (u.type === "colonyship") deployColonyShip(from, u.id);   // start ships → CCs
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  from.buildings.set(sp.id, sp);
  const ships = cargoShips.map((type, i) => {
    const u = makeUnit(type, "player", sp.x + 10 + i * 3, sp.y);   // staged on the pad
    from.units.set(u.id, u);
    return u;
  });
  g.credits = 2000;
  return { g, from, sp, ships, destId: g.worlds.find(w => w !== g.activeId) };
}

test("a Command Center actually produces cargo ships in Odyssey (the Hauler button works)", () => {
  const { from } = readyToJump(24, []);   // a deployed CC + a Spaceport (the freighter prereq)
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  from.players.player.resources.ore = 10000;
  // The bug was a menu button with no engine wiring: the CC's `produces` list omitted the ships,
  // so queueProduction silently rejected the click.
  for (const t of ["hauler", "heavyhauler", "bulkfreighter"]) {
    assert.ok(BUILDINGS.command.produces.includes(t), `${t} is in the Command Center's produces list`);
  }
  assert.equal(queueProduction(from, cc.id, "hauler"), true, "the Hauler queues at the CC");
  assert.ok(cc.queue.some(j => j.unitType === "hauler"), "…and lands in its production queue");
});

test("freightCapacity sums the cargo ships' holds and ignores anything without one", () => {
  const { ships } = readyToJump(19, ["hauler", "heavyhauler"]);
  assert.equal(freightCapacity(ships), 250 + 650, "hold = Hauler + Heavy Hauler");
  const bulk = readyToJump(19, ["bulkfreighter"]).ships;
  assert.ok(freightCapacity(bulk) > freightCapacity(ships), "a Bulk Freighter carries more than a Hauler + Heavy Hauler");
  assert.equal(freightCapacity([makeUnit("skiff", "player", 0, 0)]), 0, "a combat ship has no cargo hold");
});

test("a jump hauls manufactured goods in the staged cargo ship's hold", () => {
  const { g, from, destId } = readyToJump(20, ["hauler"]);   // hold 250
  Object.assign(from.players.player.resources, { alloys: 100, machinery: 50, ore: 500, antimatter: 30 });
  jumpCapital(g, destId);
  const dest = activeState(g);
  assert.ok((dest.players.player.resources.machinery || 0) >= 50, "machinery arrived at the destination");
  assert.ok((dest.players.player.resources.alloys || 0) >= 100, "alloys arrived too (150 total ≤ the 250 hold)");
  assert.ok((from.players.player.resources.alloys || 0) < 100, "…and left the origin colony");
  assert.equal(from.players.player.resources.ore, 500, "raw ore is never hauled");
  assert.equal(from.players.player.resources.antimatter, 30, "strategic goods stay put");
});

test("with NO cargo ship staged, a jump hauls nothing", () => {
  const { g, from, destId } = readyToJump(23, []);
  Object.assign(from.players.player.resources, { machinery: 500, alloys: 500 });
  const res = jumpCapital(g, destId);
  assert.deepEqual(res.cargo, {}, "no cargo ship → an empty hold");
  assert.equal(from.players.player.resources.machinery, 500, "the goods stay on the origin");
});

test("the hold fills most-valuable-first, up to the cargo ships' capacity", () => {
  const { from, ships } = readyToJump(21, ["hauler"]);   // hold 250
  Object.assign(from.players.player.resources, { metals: 1000, machinery: 1000 });
  const cap = freightCapacity(ships);
  const m = cargoManifest(from, cap);
  assert.equal(Object.values(m).reduce((a, b) => a + b, 0), cap, "the hold fills exactly to capacity");
  assert.equal(m.machinery, cap, "machinery (most valuable) fills the whole hold");
  assert.ok(!m.metals, "nothing left over for the cheap good");
});

test("a bigger fleet of cargo ships hauls proportionally more", () => {
  const { from, ships } = readyToJump(22, ["hauler", "hauler", "bulkfreighter"]);   // 250 + 250 + 1600
  const cap = freightCapacity(ships);
  assert.equal(cap, 2100);
  from.players.player.resources.alloys = 5000;
  assert.equal(cargoManifest(from, cap).alloys, 2100, "the whole combined hold loads");
});

/* ---------- manual load / unload (a player-managed hold per freighter) ---------- */

test("loadFreighter moves stockpile → hold (clamped to room and stock); unloadFreighter reverses it", () => {
  const { from, ships } = readyToJump(30, ["hauler"]);   // cargoHold 250
  const f = ships[0];
  Object.assign(from.players.player.resources, { alloys: 300, spice: 40 });

  assert.equal(loadFreighter(from, f.id, "alloys", 100), 100, "loads 100 alloys");
  assert.equal(f.freight.alloys, 100, "…into the hold");
  assert.equal(from.players.player.resources.alloys, 200, "…and off the stockpile");
  assert.equal(freightUsed(f), 100);
  assert.equal(freightRoom(f), 150);

  assert.equal(loadFreighter(from, f.id, "spice", 999), 40, "clamps to what's in stock (40 spice)");
  assert.equal(loadFreighter(from, f.id, "alloys", 999), 110, "then clamps to the 250 hold (110 room left)");
  assert.equal(freightUsed(f), 250, "the hold is full");
  assert.equal(loadFreighter(from, f.id, "alloys", 50), 0, "a full hold takes nothing more");

  assert.equal(unloadFreighter(from, f.id, "alloys", 50), 50, "unloads 50 alloys");
  assert.equal(f.freight.alloys, 160);
  assert.equal(from.players.player.resources.alloys, 140, "…back onto the stockpile");
});

test("loadFreighter refuses a non-freighter and an unknown commodity", () => {
  const { from, ships } = readyToJump(31, ["hauler"]);
  from.players.player.resources.alloys = 100;
  const skiff = makeUnit("skiff", "player", 0, 0); from.units.set(skiff.id, skiff);
  assert.equal(loadFreighter(from, skiff.id, "alloys", 10), 0, "a combat ship has no hold");
  assert.equal(loadFreighter(from, ships[0].id, "notacommodity", 10), 0, "an unknown commodity is rejected");
  assert.equal(from.players.player.resources.alloys, 100, "…and nothing left the stockpile");
});

test("strategic goods (antimatter / AI cores / plasma torpedoes) are loadable, though no market buys them", () => {
  const { from, ships } = readyToJump(34, ["hauler"]);   // 250 hold
  Object.assign(from.players.player.resources, { antimatter: 30, ai: 12, plasmatorp: 8 });
  assert.equal(loadFreighter(from, ships[0].id, "antimatter", 30), 30, "antimatter loads (its only sinks — Gate/Leviathan — are on other worlds)");
  assert.equal(loadFreighter(from, ships[0].id, "ai", 12), 12, "AI cores load");
  assert.equal(loadFreighter(from, ships[0].id, "plasmatorp", 8), 8, "plasma torpedoes load");
  assert.equal(from.players.player.resources.antimatter, 0, "…and left the origin stockpile");
  assert.equal(freightUsed(ships[0]), 50, "all 50 units are aboard");
});

test("a hand-loaded freighter ships EXACTLY what the player put aboard (not the auto-pick)", () => {
  const { g, from, destId, ships } = readyToJump(32, ["hauler"]);   // 250 hold
  Object.assign(from.players.player.resources, { spice: 100, machinery: 100 });
  loadFreighter(from, ships[0].id, "spice", 60);   // deliberately ship the CHEAP good, not machinery
  const res = jumpCapital(g, destId);
  const dest = activeState(g);
  assert.equal(res.cargo.spice, 60, "the jump delivered the 60 spice loaded");
  assert.ok(!res.cargo.machinery, "…and NOT the auto-load's most-valuable pick");
  assert.equal(dest.players.player.resources.spice, 60, "spice banked at the destination");
  assert.equal(from.players.player.resources.machinery, 100, "machinery stayed on the origin — never auto-loaded");
});

test("a freighter's loaded hold survives a save/load, and a tampered hold is clamped on the way in", () => {
  const { g, from, ships } = readyToJump(33, ["bulkfreighter"]);   // 1600 hold
  from.players.player.resources.alloys = 500;
  loadFreighter(from, ships[0].id, "alloys", 500);

  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rf = [...activeState(restored).units.values()].find(u => u.type === "bulkfreighter");
  assert.equal(rf.freight.alloys, 500, "the loaded alloys survive the round-trip");

  const save = serializeGalaxy(g);   // detached payload
  const tampered = save.planets.flatMap(p => p.units).find(u => u.type === "bulkfreighter");
  tampered.freight = { alloys: 1e9, notreal: 50, metals: -5 };   // over-cap + bogus + negative
  const r2 = deserializeGalaxy(JSON.parse(JSON.stringify(save)));
  const f2 = [...activeState(r2).units.values()].find(u => u.type === "bulkfreighter");
  assert.ok(f2.freight.alloys <= 1600, "over-capacity haul clamped to the ship's cargoHold");
  assert.ok(!("notreal" in f2.freight), "a bogus commodity is dropped");
  assert.ok(!("metals" in f2.freight), "a negative qty is dropped");
});
