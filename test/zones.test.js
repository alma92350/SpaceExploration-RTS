import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { assignHaul, assignService, assignFerry } from "../engine/haul.js";
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
