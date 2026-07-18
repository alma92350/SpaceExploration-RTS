import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPlacement } from "../engine/placement.js";
import { issueBuild } from "../engine/commands.js";
import { createGameState, makeBuilding } from "../engine/state.js";
import { MAP_WIDTH, MAP_HEIGHT } from "../engine/map.js";

function stubState(buildings = [], nodes = []) {
  return {
    map: { width: MAP_WIDTH, height: MAP_HEIGHT, nodes },
    buildings: new Map(buildings.map(b => [b.id, b])),
  };
}

test("isValidPlacement accepts an open spot clear of everything", () => {
  const state = stubState();
  assert.equal(isValidPlacement(state, "barracks", 800, 500), true);
});

test("isValidPlacement rejects a spot that falls off the map edge", () => {
  const state = stubState();
  assert.equal(isValidPlacement(state, "barracks", 5, 500), false, "too close to the left edge");
  assert.equal(isValidPlacement(state, "barracks", MAP_WIDTH - 5, 500), false, "too close to the right edge");
  assert.equal(isValidPlacement(state, "barracks", 800, 5), false, "too close to the top edge");
});

test("isValidPlacement rejects a spot overlapping an existing building", () => {
  const existing = makeBuilding("command", "player", 800, 500);
  const state = stubState([existing]);
  assert.equal(isValidPlacement(state, "barracks", 810, 505), false);
});

test("isValidPlacement accepts a spot with enough clearance from an existing building", () => {
  const existing = makeBuilding("command", "player", 800, 500);
  const state = stubState([existing]);
  assert.equal(isValidPlacement(state, "barracks", 950, 500), true);
});

test("isValidPlacement rejects a spot too close to an active resource node", () => {
  const state = stubState([], [{ id: "n1", com: "ore", amount: 300, max: 600, x: 800, y: 500 }]);
  assert.equal(isValidPlacement(state, "barracks", 805, 500), false);
});

test("isValidPlacement ignores a depleted resource node", () => {
  const state = stubState([], [{ id: "n1", com: "ore", amount: 0, max: 600, x: 800, y: 500 }]);
  assert.equal(isValidPlacement(state, "barracks", 805, 500), true);
});

test("isValidPlacement rejects an unknown building type instead of throwing", () => {
  const state = stubState();
  assert.equal(isValidPlacement(state, "not-a-building", 800, 500), false);
});

test("issueBuild refuses an invalid placement and doesn't charge the player", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const oreBefore = state.players.player.resources.ore;

  const result = issueBuild(state, worker.id, "barracks", cc.x, cc.y);   // right on top of the Command Center

  assert.equal(result, null);
  assert.equal(state.players.player.resources.ore, oreBefore, "an invalid placement should never be charged for");
  assert.equal(worker.order, null, "the worker should not have been sent to build on an invalid spot");
});

test("issueBuild succeeds and charges the cost at a valid, clear spot", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const oreBefore = state.players.player.resources.ore;

  const result = issueBuild(state, worker.id, "barracks", cc.x + 300, cc.y + 300);

  assert.ok(result, "a valid, clear spot should succeed");
  assert.equal(state.buildings.get(result).constructing, true);
  assert.ok(state.players.player.resources.ore < oreBefore, "a successful build should be charged");
  assert.deepEqual(worker.order, { type: "build", buildingId: result });
});
