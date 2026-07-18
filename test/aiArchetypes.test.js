import { test } from "node:test";
import assert from "node:assert/strict";
import { archetypeFor, ARCHETYPES } from "../engine/aiArchetypes.js";
import { createGameState } from "../engine/state.js";

test("each of the three playable planets maps to a distinct archetype", () => {
  const korrath = archetypeFor("korrath");
  const ferros = archetypeFor("ferros");
  const vesper = archetypeFor("vesper");

  assert.equal(korrath.name, "Rusher");
  assert.equal(ferros.name, "Economist");
  assert.equal(vesper.name, "Balanced");
});

test("an unknown planet id falls back to Balanced instead of throwing", () => {
  const result = archetypeFor("not-a-real-planet");
  assert.equal(result, ARCHETYPES.balanced);
});

test("Rusher attacks sooner and with less economy than Economist", () => {
  assert.ok(ARCHETYPES.rusher.attackTimeout < ARCHETYPES.economist.attackTimeout);
  assert.ok(ARCHETYPES.rusher.armyAttackSize < ARCHETYPES.economist.armyAttackSize);
  assert.ok(ARCHETYPES.rusher.workerTarget < ARCHETYPES.economist.workerTarget);
});

test("createGameState wires the resolved archetype onto state, matching the chosen planet", () => {
  const state = createGameState({ planetId: "korrath" });
  assert.equal(state.aiArchetype, ARCHETYPES.rusher);
});
