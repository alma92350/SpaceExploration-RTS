import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
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

test("a Barracks can queue both Skiff and Bastion", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  state.players.player.resources.ore = 1000;

  assert.equal(queueProduction(state, barracks.id, "skiff"), true);
  assert.equal(queueProduction(state, barracks.id, "bastion"), true);
  assert.equal(barracks.queue.length, 2);
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
  const state = { units: new Map() };
  const barracks = makeBuilding("barracks", "player", 500, 500, { constructing: true });

  updateBuildingConstruction(state, barracks, 5);
  assert.ok(barracks.constructing);
  assert.ok(barracks.hp > 0 && barracks.hp < barracks.maxHp);

  updateBuildingConstruction(state, barracks, 100);
  assert.equal(barracks.constructing, false);
  assert.equal(barracks.hp, barracks.maxHp);
});

test("with no worker on-site, construction still proceeds at the original (one-builder) pace", () => {
  const state = { units: new Map() };
  const barracks = makeBuilding("barracks", "player", 500, 500, { constructing: true });

  updateBuildingConstruction(state, barracks, 1);
  const solo = barracks.buildProgress;

  const barracks2 = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  const onSiteWorker = makeUnit("worker", "player", 500, 500);
  onSiteWorker.order = { type: "build", buildingId: barracks2.id };
  const state2 = { units: new Map([[onSiteWorker.id, onSiteWorker]]) };
  updateBuildingConstruction(state2, barracks2, 1);

  assert.equal(barracks2.buildProgress, solo, "one on-site worker should match the no-worker baseline pace");
});

test("a second worker on-site roughly doubles construction speed, up to the cap", () => {
  const buildingType = "barracks";
  function progressAfter(workerCount, dt) {
    const b = makeBuilding(buildingType, "player", 500, 500, { constructing: true });
    const units = new Map();
    for (let i = 0; i < workerCount; i++) {
      const w = makeUnit("worker", "player", 500 + i, 500);   // within BUILD_REACH of the site
      w.order = { type: "build", buildingId: b.id };
      units.set(w.id, w);
    }
    updateBuildingConstruction({ units }, b, dt);
    return b.buildProgress;
  }

  const oneWorker = progressAfter(1, 1);
  const twoWorkers = progressAfter(2, 1);
  const fourWorkers = progressAfter(4, 1);
  const tenWorkers = progressAfter(10, 1);   // beyond the cap

  assert.equal(twoWorkers, oneWorker * 2);
  assert.equal(fourWorkers, oneWorker * 4);
  assert.equal(tenWorkers, fourWorkers, "more than the cap shouldn't add further speed");
});

test("a worker still en route (outside BUILD_REACH) doesn't count toward the build rate", () => {
  const b = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  const farWorker = makeUnit("worker", "player", 500, 500 + 500);   // nowhere near the site
  farWorker.order = { type: "build", buildingId: b.id };
  const state = { units: new Map([[farWorker.id, farWorker]]) };

  updateBuildingConstruction(state, b, 1);

  const solo = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  updateBuildingConstruction({ units: new Map() }, solo, 1);

  assert.equal(b.buildProgress, solo.buildProgress);
});

test("an enemy worker standing nearby doesn't contribute to your build rate", () => {
  const b = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  const enemyWorker = makeUnit("worker", "ai", 500, 500);
  enemyWorker.order = { type: "build", buildingId: b.id };
  const state = { units: new Map([[enemyWorker.id, enemyWorker]]) };

  updateBuildingConstruction(state, b, 1);

  const solo = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  updateBuildingConstruction({ units: new Map() }, solo, 1);

  assert.equal(b.buildProgress, solo.buildProgress);
});
