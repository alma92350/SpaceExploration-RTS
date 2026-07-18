import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

test("the AI cycles through its archetype's exact unit mix instead of pure Skiff spam", () => {
  const state = createGameState({ planetId: "ferros" });
  const mix = state.aiArchetype.unitMix;
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  state.players.ai.resources.ore = 100000;

  const builtTypes = [];
  const rounds = mix.length * 3;
  for (let i = 0; i < rounds; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) {
      builtTypes.push(barracks.queue[barracks.queue.length - 1].unitType);
      barracks.queue.length = 0;   // clear so the next think cycle queues again immediately
    }
  }

  const expected = Array.from({ length: rounds }, (_, i) => mix[i % mix.length]);
  assert.equal(builtTypes.length, rounds, "every think cycle should have queued something with ample ore");
  assert.deepEqual(builtTypes, expected);
  assert.ok(mix.includes("lancer"), "sanity check: the fixture archetype should actually include a Lancer");
});

test("the AI's attack wave includes all three combat types, not just Skiffs", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = state.aiArchetype.attackTimeout + 50;   // well past the timeout, so it commits regardless of army size

  const skiff = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  const bastion = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  const lancer = makeUnit("lancer", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(skiff.id, skiff);
  state.units.set(bastion.id, bastion);
  state.units.set(lancer.id, lancer);

  runAI(state, THINK_INTERVAL);

  assert.equal(skiff.order?.type, "attack-move");
  assert.equal(bastion.order?.type, "attack-move");
  assert.equal(lancer.order?.type, "attack-move");
});

test("the AI launches repeated attack waves, not just one", () => {
  const state = createGameState({ planetId: "ferros" });
  const archetype = state.aiArchetype;
  state.time = archetype.attackTimeout + 1;

  const waveOne = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(waveOne.id, waveOne);
  runAI(state, THINK_INTERVAL);
  assert.equal(waveOne.order?.type, "attack-move", "the first wave should commit past the timeout");
  const firstNextAttackAt = state.aiNextAttackAt;
  assert.ok(firstNextAttackAt > state.time, "committing a wave should schedule the next one instead of never attacking again");

  // Simulate that wave being wiped out, and a fresh batch produced at home
  // in the meantime -- this unit was never sent anywhere, so it's still
  // "home army" and should form the next wave once its own timeout passes.
  state.units.delete(waveOne.id);
  const waveTwo = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(waveTwo.id, waveTwo);

  state.time = firstNextAttackAt + 1;
  runAI(state, THINK_INTERVAL);

  assert.equal(waveTwo.order?.type, "attack-move", "a second, independent wave should commit once its own timeout passes");
});

test("the AI biases production toward the counter of the player's most common combat type", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  state.players.ai.resources.ore = 100000;

  // Flood the player's army with Skiffs -- Bastion is Skiff's hard counter
  // (see entities.js's bonusVs tables), so the AI should start reacting.
  for (let i = 0; i < 5; i++) {
    const s = makeUnit("skiff", "player", 100 + i, 100);
    state.units.set(s.id, s);
  }

  const builtTypes = [];
  for (let i = 0; i < 7; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) {
      builtTypes.push(barracks.queue[barracks.queue.length - 1].unitType);
      barracks.queue.length = 0;   // clear so the next think cycle queues again immediately
    }
  }

  assert.equal(builtTypes[0], state.aiArchetype.unitMix[0], "the very first build should still follow the archetype's mix");
  assert.equal(builtTypes[3], "bastion", "the 4th unit built (the first counter-pick slot) should directly counter the player's Skiff-heavy army");
  assert.equal(builtTypes[6], "bastion", "the counter-pick recurs every 3rd unit thereafter");
});
