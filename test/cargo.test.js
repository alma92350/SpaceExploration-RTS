import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, jumpCapital, cargoManifest, freightCapacity } from "../engine/galaxy.js";
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
