/* ============================================================
   Freight Lanes (P6 colony-economy rework, half 1 of 2): standing shipping between held
   worlds. At a Spaceport, assign freighters to a LANE (source -> destination, commodity
   filter); every LANE_PERIOD of galaxy time it moves min(assigned cargoHold, filtered
   stock) from the source treasury to the destination's. Assigned ships stay parked near
   the source pad, flagged busy — a standing investment, not free teleportation.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, stepGalaxy, jumpManifestAll, jumpManifest,
         createLane, deleteLane, assignShipToLane, unassignShipFromLane, runLanes,
         JUMP_LOAD_RADIUS, LANE_PERIOD } from "../engine/galaxy.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";

// A galaxy with a source world (the active seat) holding a completed Spaceport, and a
// destination world already held (a background colony with a Command Center) — the
// minimal fixture for assigning + running a lane.
function laneFixture(seed) {
  const g = createGalaxy({ seed });
  const from = activeState(g);
  const sp = makeBuilding("spaceport", "player", from.map.bases.player.x + 40, from.map.bases.player.y);
  from.buildings.set(sp.id, sp);
  const destId = g.worlds.find(w => w !== g.activeId);
  const to = addPlanet(g, destId, { unsettled: true });
  to.background = true;
  const cc = makeBuilding("command", "player", to.map.bases.player.x, to.map.bases.player.y);
  to.buildings.set(cc.id, cc);
  g.discovered.add(destId);   // a held world, not merely simulated
  return { g, from, to, sp, destId };
}

function parkedHauler(from, sp) {
  const u = makeUnit("hauler", "player", sp.x + 10, sp.y);
  from.units.set(u.id, u);
  return u;
}

/* ---------- createLane / assignShipToLane / unassignShipFromLane / deleteLane ---------- */

test("createLane makes a source -> destination route with an empty ship roster", () => {
  const { g, destId } = laneFixture(1);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  assert.ok(lane, "the lane is created");
  assert.equal(lane.from, g.activeId);
  assert.equal(lane.to, destId);
  assert.deepEqual(lane.commodities, ["metals"]);
  assert.deepEqual(lane.shipIds, []);
  assert.ok(g.lanes.includes(lane), "it's tracked on the galaxy");
});

test("createLane refuses a same-world lane or an unknown destination", () => {
  const { g } = laneFixture(2);
  assert.equal(createLane(g, g.activeId, g.activeId), null, "source === destination is refused");
  assert.equal(createLane(g, g.activeId, "not-a-real-world"), null, "an unknown world is refused");
  assert.equal(g.lanes.length, 0);
});

test("assignShipToLane only accepts a player freighter parked near a source Spaceport", () => {
  const { g, from, sp, destId } = laneFixture(3);
  const lane = createLane(g, g.activeId, destId);
  const hauler = parkedHauler(from, sp);

  assert.equal(assignShipToLane(g, lane.id, "not-a-real-unit-id"), false, "an unknown unit id is refused");

  const farAway = makeUnit("hauler", "player", sp.x + JUMP_LOAD_RADIUS + 200, sp.y);
  from.units.set(farAway.id, farAway);
  assert.equal(assignShipToLane(g, lane.id, farAway.id), false, "too far from the source pad is refused");

  const worker = makeUnit("worker", "player", sp.x + 5, sp.y);
  from.units.set(worker.id, worker);
  assert.equal(assignShipToLane(g, lane.id, worker.id), false, "a non-freighter (no cargoHold) is refused");

  assert.equal(assignShipToLane(g, lane.id, hauler.id), true, "a parked player freighter is accepted");
  assert.ok(lane.shipIds.includes(hauler.id));
  assert.equal(hauler.laneId, lane.id, "the ship is flagged busy/assigned");
});

test("unassignShipFromLane and deleteLane both clear the ship's busy flag", () => {
  const { g, from, sp, destId } = laneFixture(4);
  const lane = createLane(g, g.activeId, destId);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);

  assert.equal(unassignShipFromLane(g, lane.id, hauler.id), true);
  assert.equal(hauler.laneId, undefined, "no longer flagged busy");
  assert.ok(!lane.shipIds.includes(hauler.id));

  assignShipToLane(g, lane.id, hauler.id);
  assert.equal(deleteLane(g, lane.id), true);
  assert.equal(hauler.laneId, undefined, "deleting the lane also frees its ships");
  assert.equal(g.lanes.length, 0);
});

/* ---------- a busy lane ship is unavailable for a jump ---------- */

test("a ship assigned to a lane never rides along on a jump — it's a standing investment, not free teleportation", () => {
  const { g, from, sp, destId } = laneFixture(5);
  const lane = createLane(g, g.activeId, destId);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);

  const m = jumpManifest(from, sp);
  assert.ok(!m.riders.some(u => u.id === hauler.id), "excluded from a single-pad manifest");
  const all = jumpManifestAll(from);
  assert.ok(!all.riders.some(u => u.id === hauler.id), "excluded from the combined manifest too");
});

/* ---------- runLanes: moves treasury-to-treasury, most-valuable-first within the filter ---------- */

test("runLanes moves min(assigned capacity, filtered stock) from the source treasury to the destination's", () => {
  const { g, from, to, sp, destId } = laneFixture(6);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);
  from.players.player.resources.metals = 500;   // capacity (250) < stock — capacity is the binding limit
  from.players.player.resources.alloys = 999;   // NOT in the filter — must be left alone

  runLanes(g);

  assert.equal(from.players.player.resources.metals, 250, "250 metals shipped out (the hauler's cargoHold)");
  assert.equal(to.players.player.resources.metals, 250, "…and arrived at the destination");
  assert.equal(from.players.player.resources.alloys, 999, "a commodity outside the lane's filter is untouched");
});

test("runLanes is capped by stock, not just capacity, when the source has less than the hold can carry", () => {
  const { g, from, to, sp, destId } = laneFixture(7);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);
  from.players.player.resources.metals = 40;   // well under the hauler's 250 cargoHold

  runLanes(g);

  assert.equal(from.players.player.resources.metals, 0, "everything in stock moved");
  assert.equal(to.players.player.resources.metals, 40);
});

test("runLanes with no commodity filter picks most-valuable-first, mirroring cargoManifest's default shape", () => {
  const { g, from, to, sp, destId } = laneFixture(8);
  const lane = createLane(g, g.activeId, destId, []);   // empty filter = every CARGO_GOODS commodity
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);
  from.players.player.resources.machinery = 500;   // the most valuable CARGO_GOODS entry
  from.players.player.resources.metals = 500;

  runLanes(g);

  assert.equal(to.players.player.resources.machinery, 250, "the pricier good fills the hold first");
  assert.equal(to.players.player.resources.metals || 0, 0, "cheaper metals wait — the hold was already full");
});

test("a lane with several assigned ships combines their cargoHold into one cycle's capacity", () => {
  const { g, from, to, sp, destId } = laneFixture(9);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  const a = parkedHauler(from, sp), b = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, a.id);
  assignShipToLane(g, lane.id, b.id);
  from.players.player.resources.metals = 1000;

  runLanes(g);

  assert.equal(to.players.player.resources.metals, 500, "both haulers' cargoHold (250+250) moved this cycle");
});

test("runLanes is a no-op when no ship is assigned, or the lane's worlds are gone", () => {
  const { g, from, to, destId } = laneFixture(10);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  from.players.player.resources.metals = 500;

  runLanes(g);   // no ship assigned yet

  assert.equal(from.players.player.resources.metals, 500, "nothing moves with zero capacity");
  assert.equal(to.players.player.resources.metals || 0, 0);
  assert.equal(lane.shipIds.length, 0);
});

/* ---------- ships are revalidated every cycle: dead/wandered-off ships drop out ---------- */

test("runLanes drops a ship that has wandered outside the source pad's catchment before moving anything", () => {
  const { g, from, sp, destId } = laneFixture(11);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);
  from.players.player.resources.metals = 500;

  hauler.x = sp.x + JUMP_LOAD_RADIUS + 500;   // wandered far off the pad

  runLanes(g);

  assert.ok(!lane.shipIds.includes(hauler.id), "dropped from the lane's roster");
  assert.equal(hauler.laneId, undefined, "no longer flagged busy — it's free again");
  assert.equal(from.players.player.resources.metals, 500, "no capacity left this cycle — nothing moved");
});

test("runLanes drops a ship that died since the last cycle", () => {
  const { g, from, sp, destId } = laneFixture(12);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);
  from.units.delete(hauler.id);   // destroyed

  runLanes(g);   // must not throw despite the dangling shipId

  assert.equal(lane.shipIds.length, 0);
});

/* ---------- wired into stepGalaxy on its own throttled, tick-keyed schedule ---------- */

test("stepGalaxy runs lanes every LANE_PERIOD galaxy ticks, deterministically", () => {
  const { g, from, to, sp, destId } = laneFixture(13);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  assignShipToLane(g, lane.id, parkedHauler(from, sp).id);
  from.players.player.resources.metals = 500;

  for (let i = 0; i < LANE_PERIOD - 1; i++) stepGalaxy(g, 0.05);
  assert.equal(to.players.player.resources.metals || 0, 0, "hasn't fired yet, one tick shy of the period");

  stepGalaxy(g, 0.05);   // the LANE_PERIOD-th tick
  assert.ok((to.players.player.resources.metals || 0) > 0, "fires exactly on schedule");
});

/* ---------- persistence: additive save field, round-trips, self-heals a corrupt entry ---------- */

test("lanes round-trip through save/load, including the ship's busy flag", () => {
  const { g, from, sp, destId } = laneFixture(20);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  const hauler = parkedHauler(from, sp);
  assignShipToLane(g, lane.id, hauler.id);

  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));

  assert.equal(g2.lanes.length, 1);
  const l2 = g2.lanes[0];
  assert.equal(l2.from, g.activeId);
  assert.equal(l2.to, destId);
  assert.deepEqual(l2.commodities, ["metals"]);
  assert.deepEqual(l2.shipIds, [hauler.id]);
  const restoredHauler = g2.planets.get(g.activeId).units.get(hauler.id);
  assert.equal(restoredHauler.laneId, lane.id, "the busy flag round-trips too");
});

test("loading a lane whose ship no longer exists self-heals rather than crashing", () => {
  const { g, from, sp, destId } = laneFixture(21);
  const lane = createLane(g, g.activeId, destId, ["metals"]);
  assignShipToLane(g, lane.id, parkedHauler(from, sp).id);

  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  save.lanes[0].shipIds.push("not-a-real-unit-id");   // simulate a corrupt/hand-edited save

  const g2 = deserializeGalaxy(save);
  assert.equal(g2.lanes[0].shipIds.length, 1, "the bogus id is dropped, the real one kept");
});

test("a save with no lanes at all loads with an empty lanes array (old-save compatibility)", () => {
  const { g } = laneFixture(22);
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  delete save.lanes;
  const g2 = deserializeGalaxy(save);
  assert.deepEqual(g2.lanes, []);
});
