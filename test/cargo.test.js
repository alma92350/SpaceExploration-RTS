import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, jumpCapital, cargoManifest, CARGO_CAPACITY } from "../engine/galaxy.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";

// A galaxy with a deployed base, a Spaceport, and a Colony Ship staged on the pad (the
// jump vessel) with fuel to go.
function readyToJump(seed = 20) {
  const g = createGalaxy({ seed });
  const from = activeState(g);
  for (const u of [...from.units.values()]) if (u.type === "colonyship") deployColonyShip(from, u.id);   // deploy start ships → CCs
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  from.buildings.set(sp.id, sp);
  const ship = makeUnit("colonyship", "player", sp.x + 20, sp.y);   // a colony ship parked on the pad carries the jump
  from.units.set(ship.id, ship);
  g.credits = 2000;
  return { g, from, destId: g.worlds.find(w => w !== g.activeId) };
}

test("a jump hauls manufactured goods to the destination and off the origin", () => {
  const { g, from, destId } = readyToJump();
  Object.assign(from.players.player.resources, { alloys: 100, machinery: 50, ore: 500, antimatter: 30 });
  jumpCapital(g, destId);
  const dest = activeState(g);   // the destination is now the active seat

  assert.ok((dest.players.player.resources.machinery || 0) >= 50, "machinery arrived at the destination");
  assert.ok((dest.players.player.resources.alloys || 0) >= 100, "alloys arrived too");
  assert.ok((from.players.player.resources.alloys || 0) < 100, "…and left the origin colony");
  // Raws are too cheap to haul; strategic goods stay committed to the origin.
  assert.equal(from.players.player.resources.ore, 500, "raw ore is never hauled");
  assert.equal(from.players.player.resources.antimatter, 30, "strategic goods stay put");
  assert.ok(!(dest.players.player.resources.antimatter > 0), "…so no antimatter rides along");
});

test("the cargo hold is capacity-bounded and loads the most valuable good first", () => {
  const { from } = readyToJump(21);
  Object.assign(from.players.player.resources, { metals: 1000, machinery: 1000 });
  const m = cargoManifest(from);
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  assert.equal(total, CARGO_CAPACITY, "the hold fills exactly to capacity");
  assert.equal(m.machinery, CARGO_CAPACITY, "machinery (most valuable) fills the whole hold");
  assert.ok(!m.metals, "nothing left over for the cheap good");
});

test("cargo is bounded so goods are still meaningfully local (you can't carry it all)", () => {
  const { from } = readyToJump(22);
  from.players.player.resources.alloys = CARGO_CAPACITY + 500;
  const m = cargoManifest(from);
  assert.equal(m.alloys, CARGO_CAPACITY, "only a capacity's worth loads");
  // the surplus stays behind on the origin after a real jump
});

test("an empty producer hauls nothing — the hold is empty until you industrialize", () => {
  const { g, from, destId } = readyToJump(23);
  const oreBefore = from.players.player.resources.ore;
  const res = jumpCapital(g, destId);
  assert.deepEqual(res.cargo, {}, "no manufactured goods → an empty hold");
  assert.equal(from.players.player.resources.ore, oreBefore, "and the raw economy is untouched");
});
