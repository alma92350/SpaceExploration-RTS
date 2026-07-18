import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

test("the AI mixes in a Bastion every Nth unit instead of pure Skiff spam", () => {
  const state = createGameState({ planetId: "ferros" });
  const ratio = state.aiArchetype.bastionRatio;
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  state.players.ai.resources.ore = 100000;

  const builtTypes = [];
  const rounds = ratio * 3;
  for (let i = 0; i < rounds; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) {
      builtTypes.push(barracks.queue[barracks.queue.length - 1].unitType);
      barracks.queue.length = 0;   // clear so the next think cycle queues again immediately
    }
  }

  const expected = Array.from({ length: rounds }, (_, i) => (i % ratio === ratio - 1 ? "bastion" : "skiff"));
  assert.equal(builtTypes.length, rounds, "every think cycle should have queued something with ample ore");
  assert.deepEqual(builtTypes, expected);
});

test("the AI's attack wave includes Bastions, not just Skiffs", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = state.aiArchetype.attackTimeout + 50;   // well past the timeout, so it commits regardless of army size

  const skiff = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  const bastion = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(skiff.id, skiff);
  state.units.set(bastion.id, bastion);

  runAI(state, THINK_INTERVAL);

  assert.equal(skiff.order?.type, "attack-move");
  assert.equal(bastion.order?.type, "attack-move");
});
