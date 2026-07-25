import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, jumpCapital, snapLandingPoint, LANDING_PICK_GRID } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";

const commandCenters = (state, owner) =>
  [...state.buildings.values()].filter(b => b.owner === owner && b.type === "command");
const spaceports = (state, owner = "player") =>
  [...state.buildings.values()].filter(b => b.owner === owner && b.type === "spaceport");
function settle(state) {
  for (const u of [...state.units.values()]) if (u.type === "colonyship") deployColonyShip(state, u.id);
  return state;
}
// Stand a finished Spaceport beside the capital so a jump can launch, and return it.
function addSpaceport(state, dx = 40, dy = 0) {
  const cc = commandCenters(state, "player")[0];
  const sp = makeBuilding("spaceport", "player", cc.x + dx, cc.y + dy);
  state.buildings.set(sp.id, sp);
  return sp;
}
// Stage a rider unit right on top of a Spaceport so it definitely rides along.
function stage(state, sp) {
  const u = makeUnit("skiff", "player", sp.x, sp.y);
  state.units.set(u.id, u);
  return u;
}

// --- snapLandingPoint: the picker's built-in imprecision -------------------

test("snapLandingPoint rounds a raw click onto the fixed grid", () => {
  const map = { width: 1600, height: 1000 };
  const p = snapLandingPoint(map, 733, 512);
  assert.equal(p.x % LANDING_PICK_GRID, 0);
  assert.equal(p.y % LANDING_PICK_GRID, 0);
});

test("snapLandingPoint clamps well clear of the map edge, even for a corner click", () => {
  const map = { width: 1600, height: 1000 };
  const topLeft = snapLandingPoint(map, 0, 0);
  const bottomRight = snapLandingPoint(map, 1600, 1000);
  assert.ok(topLeft.x >= 82 && topLeft.y >= 82, "clamped clear of the widest rider-spawn ring");
  assert.ok(bottomRight.x <= 1600 - 82 && bottomRight.y <= 1000 - 82, "clamped clear of the far edge too");
});

test("snapLandingPoint tolerates non-numeric/garbage input instead of propagating NaN", () => {
  const map = { width: 1600, height: 1000 };
  const p = snapLandingPoint(map, NaN, undefined);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

// --- landing zone selection --------------------------------------------------

test("no Spaceport at the destination and no chosen point: falls back to the world's fixed base anchor (unchanged default)", () => {
  const g = createGalaxy({ seed: 11 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  assert.equal(spaceports(dest).length, 0, "a never-visited world starts with no player Spaceport");
  const res = jumpCapital(g, destId);
  assert.ok(res, "the jump launched");
  const rider = [...dest.units.values()].find(u => u.owner === "player" && u.type === "skiff");
  const lz = dest.map.bases.player;
  assert.ok(Math.hypot(rider.x - lz.x, rider.y - lz.y) < 100, "the rider landed near the fixed base anchor");
});

test("no Spaceport at the destination, WITH a chosen point: lands near the (snapped) picked point, not the fixed anchor", () => {
  const g = createGalaxy({ seed: 12 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  const farFromBase = { x: dest.map.bases.player.x + 700, y: dest.map.bases.player.y + 300 };
  const res = jumpCapital(g, destId, { landingPoint: farFromBase });
  assert.ok(res);
  const rider = [...dest.units.values()].find(u => u.owner === "player" && u.type === "skiff");
  const expected = snapLandingPoint(dest.map, farFromBase.x, farFromBase.y);
  assert.ok(Math.hypot(rider.x - expected.x, rider.y - expected.y) < 100, "landed near the snapped chosen point");
  const lz = dest.map.bases.player;
  assert.ok(Math.hypot(rider.x - lz.x, rider.y - lz.y) > 300, "…nowhere near the fixed base anchor");
});

test("a Spaceport already standing at the destination wins over both the fixed anchor AND any chosen point", () => {
  const g = createGalaxy({ seed: 13 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  const destPad = makeBuilding("spaceport", "player", dest.map.bases.player.x + 500, dest.map.bases.player.y - 200);
  dest.buildings.set(destPad.id, destPad);   // simulates a pad built on an earlier visit
  const decoyPoint = { x: dest.map.bases.player.x - 500, y: dest.map.bases.player.y + 400 };
  const res = jumpCapital(g, destId, { landingPoint: decoyPoint });
  assert.ok(res);
  const rider = [...dest.units.values()].find(u => u.owner === "player" && u.type === "skiff");
  assert.ok(Math.hypot(rider.x - destPad.x, rider.y - destPad.y) < 100, "landed at the destination's own Spaceport");
});

test("with several never-used Spaceports at the destination, the lowest id wins the tie-break (deterministic)", () => {
  const g = createGalaxy({ seed: 14 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  const base = dest.map.bases.player;
  const padA = makeBuilding("spaceport", "player", base.x + 500, base.y);
  const padB = makeBuilding("spaceport", "player", base.x - 500, base.y);
  dest.buildings.set(padA.id, padA);
  dest.buildings.set(padB.id, padB);
  const lowestId = [padA, padB].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  const res = jumpCapital(g, destId);
  assert.ok(res);
  const rider = [...dest.units.values()].find(u => u.owner === "player" && u.type === "skiff");
  assert.ok(Math.hypot(rider.x - lowestId.x, rider.y - lowestId.y) < 100, "landed at the lower-id pad");
});

test("a jump stamps the receiving Spaceport's lastLanding — so a LATER return favours it over a lower-id pad that's never been used", () => {
  const g = createGalaxy({ seed: 15 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 4000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  const base = dest.map.bases.player;
  const padA = makeBuilding("spaceport", "player", base.x + 500, base.y);   // lower id — inserted first
  const padB = makeBuilding("spaceport", "player", base.x - 500, base.y);
  dest.buildings.set(padA.id, padA);
  dest.buildings.set(padB.id, padB);
  assert.ok(padA.id < padB.id, "test setup sanity: A really is the lower id");

  // Force the FIRST landing onto padB by picking a point right on top of it and temporarily
  // removing padA from consideration isn't possible (landingZone always prefers a standing pad),
  // so instead stamp padB's lastLanding directly — exactly what jumpCapital itself would do had
  // an earlier jump landed there — and confirm the NEXT jump honours it over padA's lower id.
  padB.lastLanding = 5;

  stage(from, sp);   // stage a fresh rider for the second jump
  const res = jumpCapital(g, destId);
  assert.ok(res);
  const rider = [...dest.units.values()].filter(u => u.owner === "player" && u.type === "skiff").pop();
  assert.ok(Math.hypot(rider.x - padB.x, rider.y - padB.y) < 100, "landed at padB (the recorded last-used pad), not lower-id padA");
});

test("end-to-end: settle a new world, build a Spaceport there, leave, and a LATER return lands at that Spaceport", () => {
  const g = createGalaxy({ seed: 16 });
  g.time = 500;   // stepGalaxy normally advances this; set directly so lastLanding stamps distinguishably from "never used"
  const homeId = g.activeId;   // captured BEFORE any jump — the world we'll hop back to
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);
  from.units.set(ship.id, ship);
  g.credits = 4000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  assert.ok(jumpCapital(g, destId), "first landing, no beacon here yet");
  // Place the new colony's Command Center directly (rather than deploying the ship that rode
  // along, which needs open, unblocked ground under it — a real placement concern this test
  // isn't about) so the rest of the scenario is deterministic regardless of this planet's terrain.
  const cc = makeBuilding("command", "player", dest.map.bases.player.x, dest.map.bases.player.y);
  dest.buildings.set(cc.id, cc);
  const destPad = addSpaceport(dest, 60, 0);   // build a Spaceport on the new colony
  assert.equal(destPad.lastLanding, undefined, "not used for a landing yet");

  // Hop home (free — already-discovered) — the new colony's own pad makes this a normal launch,
  // not a control switch — then jump BACK to destId now that a Spaceport stands there.
  assert.ok(jumpCapital(g, homeId), "hop back to the original world");
  stage(from, sp);
  assert.ok(jumpCapital(g, destId), "jump back to the colony");
  const rider = [...dest.units.values()].filter(u => u.owner === "player" && u.type === "skiff").pop();
  assert.ok(Math.hypot(rider.x - destPad.x, rider.y - destPad.y) < 100, "the return trip lands right at the colony's own Spaceport");
  assert.ok(destPad.lastLanding > 0, "the Spaceport now remembers it was used");
});

test("a Spaceport-less control-switch fallback (nothing rides) never stamps a lastLanding", () => {
  const g = createGalaxy({ seed: 17 });
  const from = settle(activeState(g));
  // Settle a second world (no Spaceport built there), then strand ourselves — jump back to the
  // FIRST world, which still has a standing Spaceport, but with no pad on the CURRENT world to
  // launch from. That's a control switch: nothing rides, so even though the destination DOES
  // have a pad to land at, nothing should ever be credited as landing there.
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);
  from.units.set(ship.id, ship);
  g.credits = 4000;
  const originalId = g.activeId;
  const newId = g.worlds.find(w => w !== g.activeId);
  const newDest = g.planets.get(newId);
  assert.ok(jumpCapital(g, newId), "settle the new world");
  deployColonyShip(newDest, [...newDest.units.values()].find(u => u.type === "colonyship").id);
  assert.equal(sp.lastLanding, undefined, "sanity: the origin's own pad was never used as a LANDING site by this jump");
  // g.activeId is now newId (no Spaceport there); jump back to the original world, which still
  // has `sp` standing — a pure control switch (canFallBack via its Command Center), not a launch.
  const res = jumpCapital(g, originalId);
  assert.ok(res, "falls back to a world you hold even with no Spaceport on the current world");
  assert.equal(res.riders, 0, "a control switch moves nothing");
  assert.equal(sp.lastLanding, undefined, "no rider landed, so the standing pad there is still never stamped");
});

// --- persistence --------------------------------------------------------------

test("a Spaceport's lastLanding survives a galaxy save/load round-trip", () => {
  const g = createGalaxy({ seed: 18 });
  g.time = 321;   // stepGalaxy normally advances this; set directly so the stamp is distinguishable from "never used"
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  const destPad = makeBuilding("spaceport", "player", dest.map.bases.player.x + 300, dest.map.bases.player.y);
  dest.buildings.set(destPad.id, destPad);
  jumpCapital(g, destId);
  assert.ok(destPad.lastLanding > 0, "sanity: the pad was stamped");

  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const restoredPad = [...restored.planets.get(destId).buildings.values()].find(b => b.id === destPad.id);
  assert.equal(restoredPad.lastLanding, destPad.lastLanding, "lastLanding round-tripped exactly");
});

test("a tampered (non-numeric / negative) lastLanding is sanitized to a safe finite value on load", () => {
  const g = createGalaxy({ seed: 19 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  stage(from, sp);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  const destPad = makeBuilding("spaceport", "player", dest.map.bases.player.x + 300, dest.map.bases.player.y);
  dest.buildings.set(destPad.id, destPad);
  jumpCapital(g, destId);

  const saved = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  const savedDest = saved.planets.find(p => p.planetId === destId);
  const savedPad = savedDest.buildings.find(b => b.id === destPad.id);
  savedPad.lastLanding = "not-a-number";
  const restored = deserializeGalaxy(saved);
  const restoredPad = [...restored.planets.get(destId).buildings.values()].find(b => b.id === destPad.id);
  assert.equal(restoredPad.lastLanding, 0, "a garbage value coerces to 0, not NaN");

  const saved2 = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  const savedPad2 = saved2.planets.find(p => p.planetId === destId).buildings.find(b => b.id === destPad.id);
  savedPad2.lastLanding = -999;
  const restored2 = deserializeGalaxy(saved2);
  const restoredPad2 = [...restored2.planets.get(destId).buildings.values()].find(b => b.id === destPad.id);
  assert.equal(restoredPad2.lastLanding, 0, "a negative value clamps to 0, never a negative timestamp");
});
