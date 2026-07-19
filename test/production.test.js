import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { queueProduction, cancelProduction, updateProductionQueue, updateBuildingConstruction, researchUpgrade } from "../engine/production.js";
import { UNITS, UPGRADES } from "../engine/entities.js";
import { tick } from "../engine/sim.js";

function commandCenterOf(state, owner) {
  return [...state.buildings.values()].find(b => b.owner === owner && b.type === "command");
}

// A completed Foundry so Tier-2 units (Lancer/Breacher) are unlocked — lets a
// test exercise the queue/cost/spawn paths for them without the tech gate.
function withFoundry(state, owner = "player") {
  const f = makeBuilding("foundry", owner, 560, 540);
  state.buildings.set(f.id, f);
  return f;
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

test("cancelProduction fully refunds an in-progress job and removes it from the queue", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = commandCenterOf(state, "player");
  const before = state.players.player.resources.ore;
  queueProduction(state, cc.id, "worker");
  updateProductionQueue(state, cc, 2);   // some progress, but nowhere near buildTime

  const ok = cancelProduction(state, cc.id, 0);

  assert.equal(ok, true);
  assert.equal(cc.queue.length, 0);
  assert.equal(state.players.player.resources.ore, before, "canceling should refund the full original cost");
});

test("cancelProduction can remove a job further back in the queue, leaving the rest intact", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  withFoundry(state);   // unlock the Lancer queued below
  state.players.player.resources.ore = 1000;
  queueProduction(state, barracks.id, "skiff");
  queueProduction(state, barracks.id, "bastion");
  queueProduction(state, barracks.id, "lancer");

  const ok = cancelProduction(state, barracks.id, 1);   // the Bastion, still waiting

  assert.equal(ok, true);
  assert.deepEqual(barracks.queue.map(j => j.unitType), ["skiff", "lancer"]);
});

test("cancelProduction refuses an out-of-range index instead of corrupting the queue", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = commandCenterOf(state, "player");
  queueProduction(state, cc.id, "worker");

  const ok = cancelProduction(state, cc.id, 5);

  assert.equal(ok, false);
  assert.equal(cc.queue.length, 1, "the real job should be untouched");
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

test("a multi-resource unit deducts every commodity in its cost, not just ore", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  withFoundry(state);
  state.players.player.resources.ore = 500;
  state.players.player.resources.radioactives = 500;

  const ok = queueProduction(state, barracks.id, "breacher");

  assert.equal(ok, true);
  assert.equal(state.players.player.resources.ore, 500 - UNITS.breacher.cost.ore);
  assert.equal(state.players.player.resources.radioactives, 500 - UNITS.breacher.cost.radioactives);
});

test("a Tier-2 unit can't be queued without its tech building; a completed Foundry unlocks it", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  state.players.player.resources.ore = 1000;

  assert.equal(queueProduction(state, barracks.id, "lancer"), false, "no Foundry -> the Lancer is locked");
  assert.equal(barracks.queue.length, 0, "and nothing is queued or charged");
  assert.equal(queueProduction(state, barracks.id, "skiff"), true, "the ungated Skiff still queues fine");

  withFoundry(state);
  assert.equal(queueProduction(state, barracks.id, "lancer"), true, "with the Foundry up, the Lancer unlocks");
});

test("the Tier-3 Dreadnought needs the Arsenal (which needs the Foundry)", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  Object.assign(state.players.player.resources, { ore: 3000, radioactives: 3000 });

  withFoundry(state);   // Tier-2 unlocked, but not Tier-3
  assert.equal(queueProduction(state, barracks.id, "dreadnought"), false, "no Arsenal -> Dreadnought locked");
  assert.equal(queueProduction(state, barracks.id, "lancer"), true, "the Tier-2 Lancer is fine");

  const ars = makeBuilding("arsenal", "player", 640, 560);   // completed Arsenal
  state.buildings.set(ars.id, ars);
  assert.equal(queueProduction(state, barracks.id, "dreadnought"), true, "with the Arsenal up, the Dreadnought unlocks");
});

test("a Breacher can't be built on ore alone with no radioactives banked", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  withFoundry(state);   // Foundry present, so the radioactives shortfall is the sole reason it's blocked
  state.players.player.resources.ore = 1000;
  state.players.player.resources.radioactives = 0;

  assert.equal(queueProduction(state, barracks.id, "breacher"), false);
  assert.equal(barracks.queue.length, 0);
});

test("a spawned Breacher rallies to the Barracks rally point like any other unit", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  withFoundry(state);
  state.players.player.resources.ore = 500;
  state.players.player.resources.radioactives = 500;
  const idsBefore = new Set(state.units.keys());
  queueProduction(state, barracks.id, "breacher");

  const dt = 0.5;
  for (let t = 0; t < UNITS.breacher.buildTime + 1; t += dt) {
    updateProductionQueue(state, barracks, dt);
  }

  const spawnedId = [...state.units.keys()].find(id => !idsBefore.has(id));
  const spawned = state.units.get(spawnedId);
  assert.equal(spawned.type, "breacher");
  assert.deepEqual(spawned.order, { type: "move", x: barracks.rally.x, y: barracks.rally.y });
});

test("rally-to-resource: a worker rallied onto a live node spawns already gathering it", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const cc = commandCenterOf(state, "player");
  const node = state.map.nodes.find(n => n.com === "ore" && n.amount > 0);
  cc.rally = { x: node.x, y: node.y, nodeId: node.id };   // rally set ON the node
  const idsBefore = new Set(state.units.keys());
  cc.queue.push({ unitType: "worker", progress: 0 });

  for (let t = 0; t < UNITS.worker.buildTime + 1 && cc.queue.length; t += 0.5) {
    updateProductionQueue(state, cc, 0.5);
  }

  const worker = state.units.get([...state.units.keys()].find(id => !idsBefore.has(id)));
  assert.equal(worker.type, "worker");
  assert.deepEqual(worker.order, { type: "gather", nodeId: node.id },
    "it heads straight to mining the rallied node instead of idling at a point");
});

test("rally-to-resource falls back to a plain move when the rallied node is drained", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const cc = commandCenterOf(state, "player");
  const node = state.map.nodes.find(n => n.com === "ore" && n.amount > 0);
  node.amount = 0;   // the seam ran dry before the worker popped
  cc.rally = { x: node.x, y: node.y, nodeId: node.id };
  const idsBefore = new Set(state.units.keys());
  cc.queue.push({ unitType: "worker", progress: 0 });

  for (let t = 0; t < UNITS.worker.buildTime + 1 && cc.queue.length; t += 0.5) {
    updateProductionQueue(state, cc, 0.5);
  }

  const worker = state.units.get([...state.units.keys()].find(id => !idsBefore.has(id)));
  assert.equal(worker.order.type, "move", "a drained rally node just sends the worker to the point");
});

test("updateBuildingConstruction advances hp with progress and finishes on schedule", () => {
  const state = { units: new Map(), events: [] };
  const barracks = makeBuilding("barracks", "player", 500, 500, { constructing: true });

  updateBuildingConstruction(state, barracks, 5);
  assert.ok(barracks.constructing);
  assert.ok(barracks.hp > 0 && barracks.hp < barracks.maxHp);

  updateBuildingConstruction(state, barracks, 100);
  assert.equal(barracks.constructing, false);
  assert.equal(barracks.hp, barracks.maxHp);
});

test("damage to a building under construction persists — construction never heals it away", () => {
  // The tick runs combat before construction, so a hit lands and then
  // updateBuildingConstruction runs. It must ADD only the sliver it built this
  // tick, not overwrite hp back up to the full progress ceiling.
  const state = { units: new Map(), events: [] };
  const b = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  updateBuildingConstruction(state, b, 5);       // ~25% built
  const ceilingBefore = b.hp;
  b.hp -= 30;                                     // an enemy hit lands this tick
  updateBuildingConstruction(state, b, 0.1);     // a sliver more construction
  assert.ok(b.hp < ceilingBefore, "the hit is not erased back up to the pre-damage ceiling");
  assert.ok(b.hp <= (ceilingBefore - 30) + 5, "construction only adds the little it built, it does not refill");
});

test("sustained fire can destroy a building before it finishes constructing", () => {
  // Out-DPS the build rate and the foundation should die, not climb to full HP
  // hit-after-hit. Uses the full tick so the real combat->construction order runs.
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  const site = makeBuilding("barracks", "player", 700, 400, { constructing: true });
  state.buildings.set(site.id, site);
  // A pack of enemy skiffs parked in weapon range, continuously firing.
  for (let i = 0; i < 6; i++) {
    const s = makeUnit("skiff", "ai", 700 + (i - 3) * 8, 430);
    state.units.set(s.id, s);
  }
  let killed = false;
  for (let i = 0; i < 400 && !killed; i++) {
    tick(state, 0.1);
    if (!state.buildings.has(site.id)) killed = true;
  }
  assert.ok(killed, "sustained fire should raze the half-built barracks");
});

test("with no worker on-site, construction still proceeds at the original (one-builder) pace", () => {
  const state = { units: new Map(), events: [] };
  const barracks = makeBuilding("barracks", "player", 500, 500, { constructing: true });

  updateBuildingConstruction(state, barracks, 1);
  const solo = barracks.buildProgress;

  const barracks2 = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  const onSiteWorker = makeUnit("worker", "player", 500, 500);
  onSiteWorker.order = { type: "build", buildingId: barracks2.id };
  const state2 = { units: new Map([[onSiteWorker.id, onSiteWorker]]), events: [] };
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
    updateBuildingConstruction({ units, events: [] }, b, dt);
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
  const state = { units: new Map([[farWorker.id, farWorker]]), events: [] };

  updateBuildingConstruction(state, b, 1);

  const solo = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  updateBuildingConstruction({ units: new Map(), events: [] }, solo, 1);

  assert.equal(b.buildProgress, solo.buildProgress);
});

test("an enemy worker standing nearby doesn't contribute to your build rate", () => {
  const b = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  const enemyWorker = makeUnit("worker", "ai", 500, 500);
  enemyWorker.order = { type: "build", buildingId: b.id };
  const state = { units: new Map([[enemyWorker.id, enemyWorker]]), events: [] };

  updateBuildingConstruction(state, b, 1);

  const solo = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  updateBuildingConstruction({ units: new Map(), events: [] }, solo, 1);

  assert.equal(b.buildProgress, solo.buildProgress);
});

test("an under-construction Command Center refuses production until it completes", () => {
  const state = createGameState({ planetId: "ferros" });
  const expansion = makeBuilding("command", "player", 800, 500, { constructing: true });
  state.buildings.set(expansion.id, expansion);

  assert.equal(queueProduction(state, expansion.id, "worker"), false);

  updateBuildingConstruction(state, expansion, 1000);   // more than enough to finish the 30s build

  assert.equal(expansion.constructing, false);
  assert.equal(queueProduction(state, expansion.id, "worker"), true);
});

test("a planet build-time modifier speeds construction and production alike", () => {
  // Construction: barracks buildTime 20; a 0.5 modifier should finish it in
  // half the seconds of build progress.
  const state = { units: new Map(), events: [], map: { modifiers: { buildTimeMult: 0.5 } } };
  const barracks = makeBuilding("barracks", "player", 500, 500, { constructing: true });
  updateBuildingConstruction(state, barracks, 10);
  assert.equal(barracks.constructing, false, "half build-time completes the barracks in 10s, not 20");

  // Production: a queued worker (buildTime 8) should pop out in ~4s under 0.5.
  const game = createGameState({ planetId: "ferros" });
  game.map.modifiers = { buildTimeMult: 0.5 };
  const cc = [...game.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  queueProduction(game, cc.id, "worker");
  const idsBefore = new Set(game.units.keys());
  for (let t = 0; t < UNITS.worker.buildTime / 2 + 0.5; t += 0.5) updateProductionQueue(game, cc, 0.5);
  const spawned = [...game.units.keys()].find(id => !idsBefore.has(id));
  assert.ok(spawned, "the queued worker spawns in half its normal build time");
});

test("researchUpgrade pays the cost and flags it researched", () => {
  const state = createGameState({ planetId: "ferros" });
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  state.players.player.resources.crystals = 200;

  const ok = researchUpgrade(state, refinery.id, "reinforcedPlating");

  assert.equal(ok, true);
  assert.equal(state.players.player.resources.crystals, 200 - UPGRADES.reinforcedPlating.cost.crystals);
  assert.equal(state.players.player.upgrades.reinforcedPlating, true);
});

test("researchUpgrade refuses a second purchase of the same upgrade", () => {
  const state = createGameState({ planetId: "ferros" });
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  state.players.player.resources.crystals = 1000;

  researchUpgrade(state, refinery.id, "reinforcedPlating");
  const spentAfterFirst = state.players.player.resources.crystals;
  const ok = researchUpgrade(state, refinery.id, "reinforcedPlating");

  assert.equal(ok, false);
  assert.equal(state.players.player.resources.crystals, spentAfterFirst, "shouldn't be charged twice");
});

test("researchUpgrade refuses while the Refinery is still under construction", () => {
  const state = createGameState({ planetId: "ferros" });
  const refinery = makeBuilding("refinery", "player", 500, 500, { constructing: true });
  state.buildings.set(refinery.id, refinery);
  state.players.player.resources.crystals = 1000;

  assert.equal(researchUpgrade(state, refinery.id, "reinforcedPlating"), false);
});

test("researchUpgrade refuses when the player can't afford it", () => {
  const state = createGameState({ planetId: "ferros" });
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  state.players.player.resources.radioactives = 0;

  assert.equal(researchUpgrade(state, refinery.id, "overchargedWeapons"), false);
});

test("upgrade doctrines are mutually exclusive: committing to one locks the other", () => {
  const state = createGameState({ planetId: "ferros" });
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  Object.assign(state.players.player.resources, { ore: 2000, crystals: 2000, radioactives: 2000 });

  assert.equal(researchUpgrade(state, refinery.id, "overchargedWeapons"), true, "commit to Assault");
  assert.equal(researchUpgrade(state, refinery.id, "reinforcedPlating"), false, "the Bulwark path is now locked out");
  assert.equal(state.players.player.upgrades.reinforcedPlating, undefined, "and nothing of the other doctrine is set/charged");
  assert.equal(researchUpgrade(state, refinery.id, "overchargedCore"), true, "but deepening the chosen doctrine is fine");
});

test("a Tier-2 upgrade needs its Tier-1 first", () => {
  const state = createGameState({ planetId: "ferros" });
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  Object.assign(state.players.player.resources, { ore: 2000, radioactives: 2000 });

  assert.equal(researchUpgrade(state, refinery.id, "overchargedCore"), false, "Tier-2 locked without Tier-1");
  assert.equal(researchUpgrade(state, refinery.id, "overchargedWeapons"), true, "research Tier-1...");
  assert.equal(researchUpgrade(state, refinery.id, "overchargedCore"), true, "...now Tier-2 unlocks");
});
