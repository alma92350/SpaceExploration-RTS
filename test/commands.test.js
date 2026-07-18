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

test("issueSetRally replaces a building's rally point", () => {
  const building = makeBuilding("command", "player", 500, 500);
  const originalRally = building.rally;

  issueSetRally(building, 900, 300);

  assert.deepEqual(building.rally, { x: 900, y: 300 });
  assert.notDeepEqual(building.rally, originalRally);
});
