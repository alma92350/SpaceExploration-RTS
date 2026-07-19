import { test } from "node:test";
import assert from "node:assert/strict";
import { issueMove, issueAttackMove, issueAttack, issueGather, issueBuild, issueAssistBuild, issueSetRally } from "../engine/commands.js";
import { createGameState, makeBuilding } from "../engine/state.js";
import { BUILDINGS } from "../engine/entities.js";

function dummyUnits(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, order: null, cargo: { com: null, qty: 0 } }));
}

function playerWorker(state) {
  return [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
}

test("issueMove spreads a group across distinct destinations instead of one shared point", () => {
  const units = dummyUnits(6);
  issueMove(units, 900, 700);

  const dests = units.map(u => `${u.order.x},${u.order.y}`);
  assert.equal(new Set(dests).size, 6, "every unit should get its own destination");
});

test("issueMove leaves a lone unit's destination exactly on the clicked point", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);
  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 });
});

test("issueAttackMove centers the formation on the target point", () => {
  const units = dummyUnits(4);
  issueAttackMove(units, 900, 700);

  const avgX = units.reduce((s, u) => s + u.order.x, 0) / units.length;
  const avgY = units.reduce((s, u) => s + u.order.y, 0) / units.length;
  assert.equal(avgX, 900);
  assert.equal(avgY, 700);
  units.forEach(u => assert.equal(u.order.type, "attack-move"));
});

test("issueAttack sends every unit at the same explicit target id (focus fire, no spreading)", () => {
  const units = dummyUnits(3);
  issueAttack(units, "target-1");
  units.forEach(u => assert.deepEqual(u.order, { type: "attack", targetId: "target-1" }));
});

test("issueGather only assigns cargo-capable units", () => {
  const units = dummyUnits(2);
  units[1].cargo = null;   // simulate a non-worker slipping into the selection
  issueGather(units, "node-1");
  assert.deepEqual(units[0].order, { type: "gather", nodeId: "node-1" });
  assert.equal(units[1].order, null);
});

test("issueAssistBuild sends every worker in the group to the same site, no formation spreading", () => {
  const units = dummyUnits(3);
  issueAssistBuild(units, "site-1");
  units.forEach(u => assert.deepEqual(u.order, { type: "build", buildingId: "site-1" }));
});

test("issueAssistBuild only assigns cargo-capable (worker) units", () => {
  const units = dummyUnits(2);
  units[1].cargo = null;   // e.g. a skiff caught in the same selection
  issueAssistBuild(units, "site-1");
  assert.deepEqual(units[0].order, { type: "build", buildingId: "site-1" });
  assert.equal(units[1].order, null);
});

test("issueBuild pays the cost, founds a constructing site, and puts the worker on it", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  const before = state.players.player.resources.ore;

  const id = issueBuild(state, worker.id, "barracks", 800, 500);

  assert.ok(id, "a successful build should return the new site's id");
  assert.equal(state.players.player.resources.ore, before - BUILDINGS.barracks.cost.ore);
  const site = state.buildings.get(id);
  assert.equal(site.constructing, true);
  assert.equal(site.buildProgress, 0);
  assert.deepEqual(worker.order, { type: "build", buildingId: id });
});

test("issueBuild gates a Foundry on a completed Barracks", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 1000;

  // No Barracks yet -> the Foundry's prereq is unmet, so founding is refused.
  assert.equal(issueBuild(state, worker.id, "foundry", 800, 500), null, "no Barracks -> Foundry refused");

  const barracks = makeBuilding("barracks", "player", 700, 500);   // completed
  state.buildings.set(barracks.id, barracks);
  const id = issueBuild(state, worker.id, "foundry", 820, 520);
  assert.ok(id, "with a completed Barracks, the Foundry can be founded");
});

test("issueBuild refuses when the player can't afford it: no site, no charge", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 0;
  const buildingsBefore = state.buildings.size;

  const id = issueBuild(state, worker.id, "barracks", 800, 500);

  assert.equal(id, null);
  assert.equal(state.buildings.size, buildingsBefore);
  assert.equal(state.players.player.resources.ore, 0);
  assert.equal(worker.order, null);
});

test("issueBuild refuses an invalid placement without charging for it", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const before = state.players.player.resources.ore;
  const buildingsBefore = state.buildings.size;

  const id = issueBuild(state, worker.id, "barracks", cc.x, cc.y);   // dead center of the Command Center

  assert.equal(id, null);
  assert.equal(state.players.player.resources.ore, before, "a rejected placement must not cost anything");
  assert.equal(state.buildings.size, buildingsBefore);
  assert.equal(worker.order, null);
});

test("a Command Center expansion is issuable like any building: charged in full, founded constructing", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 500;   // the starting 300 deliberately can't afford the 400 up front

  const id = issueBuild(state, worker.id, "command", 800, 500);

  assert.ok(id, "a clear spot with funds in hand should found the expansion");
  assert.equal(state.players.player.resources.ore, 500 - BUILDINGS.command.cost.ore);
  const site = state.buildings.get(id);
  assert.equal(site.type, "command");
  assert.equal(site.constructing, true);
});

test("issueBuild pays a multi-commodity cost and refuses when the crystal half is missing", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 500;
  state.players.player.resources.crystals = 200;

  const id = issueBuild(state, worker.id, "turret", 800, 500);

  assert.ok(id, "a clear spot with both commodities in hand should found the turret");
  assert.equal(state.players.player.resources.ore, 500 - BUILDINGS.turret.cost.ore);
  assert.equal(state.players.player.resources.crystals, 200 - BUILDINGS.turret.cost.crystals);

  state.players.player.resources.crystals = 0;   // ore still ample, but the crystal half is gone
  const oreBefore = state.players.player.resources.ore;
  const buildingsBefore = state.buildings.size;

  const denied = issueBuild(state, worker.id, "turret", 900, 500);

  assert.equal(denied, null, "ore alone can't cover a crystal-costed building");
  assert.equal(state.buildings.size, buildingsBefore, "a rejected build founds no site");
  assert.equal(state.players.player.resources.ore, oreBefore, "and charges nothing");
});

test("a queued order appends as a waypoint instead of replacing the active one", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);              // plain: takes effect now
  issueMove([unit], 600, 400, true);        // queued behind it
  issueAttackMove([unit], 700, 400, true);  // queued behind that

  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 }, "the active order is untouched");
  assert.equal(unit.orderQueue.length, 2, "both queued commands are waiting");
  assert.deepEqual(unit.orderQueue[0], { type: "move", x: 600, y: 400 });
  assert.equal(unit.orderQueue[1].type, "attack-move");
});

test("a queued order to a fully idle unit takes effect immediately, not as a dead first waypoint", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400, true);   // queued, but nothing is active or waiting yet
  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 });
  assert.equal(unit.orderQueue.length, 0);
});

test("a plain order clears any queued waypoints", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);
  issueMove([unit], 600, 400, true);
  issueMove([unit], 700, 400, true);
  assert.equal(unit.orderQueue.length, 2);

  issueAttack([unit], "target-1");   // a plain command cancels the chain
  assert.deepEqual(unit.order, { type: "attack", targetId: "target-1" });
  assert.equal(unit.orderQueue.length, 0);
});

test("queued orders are context-sensitive — a mix of move, attack, and gather in one chain", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);
  issueAttack([unit], "enemy-9", true);
  issueGather([unit], "node-3", true);

  assert.equal(unit.orderQueue.length, 2);
  assert.deepEqual(unit.orderQueue[0], { type: "attack", targetId: "enemy-9" });
  assert.deepEqual(unit.orderQueue[1], { type: "gather", nodeId: "node-3" });
});

test("issueSetRally replaces a building's rally point", () => {
  const building = makeBuilding("command", "player", 500, 500);
  const originalRally = building.rally;

  issueSetRally(building, 900, 300);

  assert.deepEqual(building.rally, { x: 900, y: 300, nodeId: null });
  assert.notDeepEqual(building.rally, originalRally);
});

test("issueSetRally can bind the rally to a resource node for rally-to-mine", () => {
  const building = makeBuilding("command", "player", 500, 500);
  issueSetRally(building, 620, 480, "n7");
  assert.deepEqual(building.rally, { x: 620, y: 480, nodeId: "n7" });
});
