import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { assignHaul, assignService, assignFerry, assignShuttle } from "../engine/haul.js";
import { storeCapOf } from "../engine/entities.js";
import { mulberry32 } from "./_helpers.js";

// A two-base layout shared by every test below: CC-A at the origin, CC-B 1000 away on the same
// axis. Every "trap" building sits CLOSER to the worker than the correct answer, but belongs to
// the OTHER base's zone — so a test only passes if the zone-first preference (engine/gather.js
// zoneFirst) actually overrides raw nearest-distance, not merely by coincidence.
function twoBases(seed = 1) {
  const s = createGameState({ planetId: "ferros", rng: mulberry32(seed) });
  const ccA = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  ccA.x = 0; ccA.y = 0;
  const ccB = makeBuilding("command", "player", 1000, 0);
  s.buildings.set(ccB.id, ccB);
  const worker = [...s.units.values()].find(u => u.owner === "player" && u.type === "worker");
  worker.x = 300; worker.y = 0;   // home zone = CC-A (dist 300 vs 700)
  return { s, ccA, ccB, worker };
}

test("assignHaul prefers a backed-up producer in the worker's OWN Command Center zone over a nearer one in another base's zone", () => {
  const { s, worker } = twoBases();
  // Zone A (belongs to ccA: dist 500 < 1500 to ccB), far from the worker (800 away).
  const farA = makeBuilding("plasmarig", "player", -500, 0);
  farA.store = { ore: 60 };
  s.buildings.set(farA.id, farA);
  // Zone B (belongs to ccB: dist 350 < 650 to ccA), but CLOSER to the worker (350 away) — the trap.
  const nearB = makeBuilding("plasmarig", "player", 650, 0);
  nearB.store = { ore: 60 };
  s.buildings.set(nearB.id, nearB);

  assignHaul(s, worker);

  assert.ok(worker.order, "the worker took a haul job");
  assert.equal(worker.order.buildingId, farA.id, "it chose the FARTHER producer because it's in its own zone, not the nearer cross-zone one");
});

test("assignService prefers a needy factory in the worker's own zone over a nearer one across the map", () => {
  const { s, worker } = twoBases();
  s.players.player.resources.ore = 1000;   // plenty in the treasury for either factory to draw on
  const farA = makeBuilding("smelter", "player", -500, 0);
  s.buildings.set(farA.id, farA);
  const nearB = makeBuilding("smelter", "player", 650, 0);
  s.buildings.set(nearB.id, nearB);

  assignService(s, worker);

  assert.ok(worker.order, "the worker took a service job");
  assert.equal(worker.order.buildingId, farA.id, "it serviced the own-zone smelter, not the nearer cross-zone one");
});

test("assignFerry prefers a collection-point freighter in the worker's own zone over a nearer one across the map", () => {
  const { s, worker } = twoBases();
  const farA = makeUnit("hauler", "player", -500, 0);
  farA.collectPoint = true;
  s.units.set(farA.id, farA);
  // A backlog right next to farA so assignFerry has something worth fetching once it picks this ship
  // (plasmarig storeCap 120 × the 34% assign-fraction ≈ 41 — comfortably past that).
  const rigNearFarA = makeBuilding("plasmarig", "player", -520, 0);
  rigNearFarA.store = { ore: 60 };
  s.buildings.set(rigNearFarA.id, rigNearFarA);

  const nearB = makeUnit("hauler", "player", 650, 0);
  nearB.collectPoint = true;
  s.units.set(nearB.id, nearB);

  assignFerry(s, worker);

  assert.ok(worker.order, "the worker took a ferry job");
  assert.equal(worker.order.freighterId, farA.id, "it ferries the own-zone freighter, not the nearer cross-zone one");
});

test("a player-assigned home base (unit.homeCC) overrides the usual nearest-CC guess, even against raw proximity", () => {
  const { s, ccA, worker } = twoBases();
  worker.x = 900; worker.y = 0;      // now physically much closer to CC-B (100 away) than CC-A (900 away)
  worker.homeCC = ccA.id;            // but explicitly assigned home base is CC-A

  const farA = makeBuilding("plasmarig", "player", -500, 0);    // zone A, far from the worker
  farA.store = { ore: 60 };
  s.buildings.set(farA.id, farA);
  const nearB = makeBuilding("plasmarig", "player", 950, 0);    // zone B, right next to the worker — the trap
  nearB.store = { ore: 60 };
  s.buildings.set(nearB.id, nearB);

  assignHaul(s, worker);

  assert.equal(worker.order.buildingId, farA.id, "the assigned home base wins over both raw proximity and the usual nearest-CC guess");
});

test("a valid home-base assignment is a HARD boundary — an empty home zone stays idle instead of poaching another base's job", () => {
  const { s, ccA, worker } = twoBases();
  worker.homeCC = ccA.id;   // explicitly assigned to CC-A, whose zone has nothing backed up

  // The only backlog on the whole map sits in CC-B's zone — reachable, and exactly what the
  // DEFAULT (no override) nearest-CC guess would fall back to, but NOT what an explicit
  // assignment should ever reach into.
  const nearB = makeBuilding("plasmarig", "player", 650, 0);
  nearB.store = { ore: 60 };
  s.buildings.set(nearB.id, nearB);

  assignHaul(s, worker);

  assert.equal(worker.order, null, "an explicit home-base assignment never commutes to another base's territory on its own");
});

test("reassigning to a different Command Center immediately redraws the hard boundary", () => {
  const { s, ccB, worker } = twoBases();
  worker.homeCC = ccB.id;   // now assigned to CC-B instead

  const nearB = makeBuilding("plasmarig", "player", 650, 0);   // in CC-B's zone
  nearB.store = { ore: 60 };
  s.buildings.set(nearB.id, nearB);

  assignHaul(s, worker);

  assert.equal(worker.order.buildingId, nearB.id, "reassigning the home base immediately opens up its zone's jobs");
});

test("clearing the home-base override (homeCC = null) restores the default distance-based guess", () => {
  const { s, ccA, worker } = twoBases();
  worker.homeCC = ccA.id;
  const nearB = makeBuilding("plasmarig", "player", 650, 0);
  nearB.store = { ore: 60 };
  s.buildings.set(nearB.id, nearB);
  assignHaul(s, worker);
  assert.equal(worker.order, null, "still pinned to CC-A's empty zone");

  worker.homeCC = null;   // player clears the assignment ("assign to nothing")
  assignHaul(s, worker);

  assert.equal(worker.order.buildingId, nearB.id, "with no override, the default nearest-CC guess (and its global fallback) applies again");
});

test("a stale home-base override (its Command Center gone) is ignored, falling back to the nearest-CC guess", () => {
  const { s, worker } = twoBases();
  worker.homeCC = "some-destroyed-cc-id";
  const near = makeBuilding("plasmarig", "player", 350, 0);
  near.store = { ore: 60 };
  s.buildings.set(near.id, near);

  assignHaul(s, worker);

  assert.equal(worker.order.buildingId, near.id, "an invalid override doesn't dead-end the search — it just falls back");
});

test("with only ONE Command Center, zone-first degenerates to the plain nearest search (unchanged behaviour)", () => {
  const s = createGameState({ planetId: "ferros" });
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.x = 0; cc.y = 0;
  const worker = [...s.units.values()].find(u => u.owner === "player" && u.type === "worker");
  worker.x = 300; worker.y = 0;
  const near = makeBuilding("plasmarig", "player", 350, 0);
  near.store = { ore: 60 };
  s.buildings.set(near.id, near);
  const far = makeBuilding("plasmarig", "player", -900, 0);
  far.store = { ore: 60 };
  s.buildings.set(far.id, far);

  assignHaul(s, worker);

  assert.equal(worker.order.buildingId, near.id, "plain nearest-distance still wins when there's only one zone");
});

test("a partly-loaded collection-point freighter shuttles home when its OWN zone has nothing left (T2)", () => {
  // assignShuttle's "don't leave yet" guard ran nearestBacklogProducer with no home id, so it fell
  // through zoneFirst's UNBOUNDED global second pass: the ship waited on a backlog anywhere in the
  // empire, however far away, even though every producer that could actually feed it is zone-local
  // (assignFerry is zone-first). It was also the only zone-aware scan in the file that didn't
  // forward unit.homeCC, so pinning the ship's home base didn't help either. The stall scales with
  // how well the player is doing — more bases means more chance something somewhere is backed up.
  const { s, ccA, ccB } = twoBases(5);
  const freighter = makeUnit("hauler", "player", ccA.x + 30, ccA.y);
  freighter.collectPoint = true;
  freighter.anchor = { x: freighter.x, y: freighter.y };
  freighter.freight = { ore: 30 };                       // partly loaded
  s.units.set(freighter.id, freighter);

  // A backed-up producer in the OTHER zone, and nothing at all in this one.
  const rig = makeBuilding("plasmarig", "player", ccB.x + 40, ccB.y);
  rig.constructing = false;
  rig.store = { plasmatorp: storeCapOf("plasmarig") };
  s.buildings.set(rig.id, rig);

  assignShuttle(s, freighter);
  assert.ok(freighter.order && freighter.order.type === "shuttle",
    "with its own zone empty the ship must deliver, not wait on another base's backlog");
});

test("a partly-loaded freighter still waits while its OWN zone is backed up (T2 fence)", () => {
  const { s, ccA } = twoBases(6);
  const freighter = makeUnit("hauler", "player", ccA.x + 30, ccA.y);
  freighter.collectPoint = true;
  freighter.anchor = { x: freighter.x, y: freighter.y };
  freighter.freight = { ore: 30 };
  s.units.set(freighter.id, freighter);
  const rig = makeBuilding("plasmarig", "player", ccA.x + 60, ccA.y);
  rig.constructing = false;
  rig.store = { plasmatorp: storeCapOf("plasmarig") };
  s.buildings.set(rig.id, rig);

  assignShuttle(s, freighter);
  assert.equal(freighter.order, null, "there is still more worth waiting for, right here");
});
