import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { updateGather } from "../engine/gather.js";

function firstNode(state, com) {
  return state.map.nodes.find(n => n.com === com);
}

test("a worker walks to its node, fills cargo, then walks back and deposits", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const startOre = state.players.player.resources.ore;

  worker.order = { type: "gather", nodeId: node.id };

  // Run enough fixed ticks for a full walk-mine-walk-deposit cycle without
  // hardcoding tick counts to exact travel time (map geometry can shift).
  for (let i = 0; i < 2000 && state.players.player.resources.ore === startOre; i++) {
    updateGather(state, worker, 0.05);
  }

  assert.ok(state.players.player.resources.ore > startOre, "resources should increase after a deposit");
  assert.ok(node.amount < node.max, "the node should have less left after being mined");
});

test("mining respects the worker's cargo cap", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  worker.x = node.x; worker.y = node.y;   // skip travel — isolate the mining phase
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50; i++) updateGather(state, worker, 0.5);

  assert.ok(worker.cargo.qty <= 10, "cargo never exceeds the worker's cap");
});

test("a fully depleted node leaves the worker idle after its final deposit", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  node.amount = 4;   // less than one worker's cargo cap
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 2000 && worker.order; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order, null);
  assert.ok(node.amount <= 0);
});
