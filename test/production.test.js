import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { queueProduction, updateProductionQueue, updateBuildingConstruction } from "../engine/production.js";
import { UNITS } from "../engine/entities.js";

function commandCenterOf(state, owner) {
  return [...state.buildings.values()].find(b => b.owner === owner && b.type === "command");
}

test("queueProduction pays the cost and enqueues the job", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = commandCenterOf(state, "player");
  const before = state.players.player.resources.ore;

  const ok = queueProduction(state, cc.id, "worker");

  assert.equal(ok, true);
  assert.equal(state.players.player.resources.ore, before - UNITS.worker.cost.ore);
  assert.equal(cc.queue.length, 1);
});

test("queueProduction refuses when the player can't afford it", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = commandCenterOf(state, "player");
  state.players.player.resources.ore = 0;

  const ok = queueProduction(state, cc.id, "worker");

  assert.equal(ok, false);
  assert.equal(cc.queue.length, 0);
});

test("queueProduction refuses a unit type the building can't produce", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = commandCenterOf(state, "player");
  const ok = queueProduction(state, cc.id, "skiff");   // only a Barracks produces skiffs
  assert.equal(ok, false);
});

test("a queued unit spawns once its build time elapses, at the building and owned by it", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = commandCenterOf(state, "player");
  const idsBefore = new Set(state.units.keys());
  queueProduction(state, cc.id, "worker");

  const dt = 0.5;
  for (let t = 0; t < UNITS.worker.buildTime + 1; t += dt) {
    updateProductionQueue(state, cc, dt);
  }

  assert.equal(cc.queue.length, 0);
  const spawnedId = [...state.units.keys()].find(id => !idsBefore.has(id));
  assert.ok(spawnedId, "a new unit id should exist");
  const spawned = state.units.get(spawnedId);
  assert.equal(spawned.type, "worker");
  assert.equal(spawned.owner, "player");
});

test("updateBuildingConstruction advances hp with progress and finishes on schedule", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500, { constructing: true });

  updateBuildingConstruction(barracks, 5);
  assert.ok(barracks.constructing);
  assert.ok(barracks.hp > 0 && barracks.hp < barracks.maxHp);

  updateBuildingConstruction(barracks, 100);
  assert.equal(barracks.constructing, false);
  assert.equal(barracks.hp, barracks.maxHp);
});
